import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { PermissionService, type Actor } from "../permissions/permission.service";
import type { PermissionsJson } from "../permissions/catalog";
import { SlidingWindowLimiter, type LimitResult } from "../common/rate-limit";
import { apiKeyError } from "./api-key-errors";
import { newApiKey, parseApiKey, sameHash } from "./api-key-format";
import { scopesToPermissions, storedScopesToPermissions, validateScopes, type KeyScopes } from "./api-key-scopes";

/** Active keys per workspace. */
export const API_KEYS_MAX = 25;
/** Requests per minute per key. */
export const API_KEY_RPM = 600;
/** `lastUsedAt` is written at most once per this many ms per key. */
export const LAST_USED_THROTTLE_MS = 60_000;
const MAX_EXPIRY_MS = 2 * 366 * 24 * 60 * 60 * 1000;
const NAME_MAX = 60;

/** SP-27: the per-key request limiter (in memory, per process). */
export class ApiKeyRateLimiter {
  private readonly limiter: SlidingWindowLimiter;
  constructor(now?: () => number) {
    this.limiter = new SlidingWindowLimiter({ limit: API_KEY_RPM, windowMs: 60_000, now, maxKeys: 10_000 });
  }
  hit(keyId: string): LimitResult {
    return this.limiter.hit(keyId);
  }
}

export interface CreateApiKeyInput {
  name?: unknown;
  scopes?: unknown;
  expiresAt?: unknown;
}

export type ApiKeyStatus = "active" | "expired" | "revoked";

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  scopes: KeyScopes;
  createdBy: { id: string; name: string } | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  status: ApiKeyStatus;
  createdAt: Date;
}

/** What AuthGuard puts on the request for a key. */
export interface AuthenticatedKey {
  id: string;
  workspaceId: string;
  createdById: string;
  /** The key's scopes as catalogue permissions (intersected with the
   *  creator's role by PermissionGuard). */
  permissions: PermissionsJson;
}

type KeyRow = {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: Prisma.JsonValue;
  createdById: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdBy?: { id: string; name: string } | null;
};

function statusOf(row: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): ApiKeyStatus {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

function toDto(row: KeyRow, now: Date): ApiKeyDto {
  let scopes: KeyScopes = {};
  try {
    scopes = validateScopes(row.scopes);
  } catch {
    scopes = {};
  }
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    status: statusOf(row, now),
    createdAt: row.createdAt,
  };
}

/**
 * SP-27 organization API keys. A key acts as its creator: its permissions are
 * the creator's CURRENT role intersected with its scopes (PermissionGuard),
 * and it stops working when the creator leaves the workspace (and is deleted
 * with the user row). Only `sha256(key)` is stored; the key is returned once,
 * by `create`, and never logged.
 */
@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);
  /** keyId → last `lastUsedAt` write (ms). */
  private readonly lastWrite = new Map<string, number>();
  readonly limiter: ApiKeyRateLimiter;
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
  ) {
    this.limiter = new ApiKeyRateLimiter(() => this.now().getTime());
  }

  async list(workspaceId: string): Promise<{ items: ApiKeyDto[] }> {
    const rows = (await this.prisma.apiKey.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      include: { createdBy: { select: { id: true, name: true } } },
    })) as KeyRow[];
    const now = this.now();
    return { items: rows.map((r) => toDto(r, now)) };
  }

  /**
   * Mints a key. The scopes must be allowed resources (400
   * `api_keys.scope_not_allowed`) and within the creator's own role (403
   * `api_keys.scope_above_role`); the creator must be a member. At most
   * API_KEYS_MAX active keys per workspace (409).
   */
  async create(workspaceId: string, actor: Actor, input: CreateApiKeyInput): Promise<ApiKeyDto & { key: string }> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > NAME_MAX) throw apiKeyError("api_keys.invalid_name");
    const scopes = validateScopes(input.scopes);
    const now = this.now();
    let expiresAt: Date | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== "") {
      const d = typeof input.expiresAt === "string" ? new Date(input.expiresAt) : null;
      if (!d || Number.isNaN(d.getTime()) || d.getTime() <= now.getTime() || d.getTime() > now.getTime() + MAX_EXPIRY_MS) {
        throw apiKeyError("api_keys.invalid_expiry");
      }
      expiresAt = d;
    }

    // A key acts as its creator, so its creator must be a real member, and it
    // cannot carry more than the creator holds ("you cannot grant more than
    // you hold", SP-25). Super-admin and impersonation sessions get no bypass.
    const eff = await this.perms.effective(workspaceId, actor.userId);
    if (!eff) throw apiKeyError("api_keys.scope_above_role");
    try {
      await this.perms.assertCanGrant(workspaceId, { userId: actor.userId }, scopesToPermissions(scopes));
    } catch (e) {
      if (e instanceof ForbiddenException) throw apiKeyError("api_keys.scope_above_role");
      throw e;
    }

    const minted = newApiKey();
    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`api-keys:${workspaceId}`}))`;
        const active = await tx.apiKey.count({
          where: { workspaceId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        });
        if (active >= API_KEYS_MAX) throw apiKeyError("api_keys.limit_reached", { max: API_KEYS_MAX });
        const created = await tx.apiKey.create({
          data: {
            workspaceId,
            name,
            prefix: minted.prefix,
            hash: minted.hash,
            scopes: scopes as Prisma.InputJsonValue,
            createdById: actor.userId,
            expiresAt,
          },
        });
        await this.audit.record(tx, {
          workspaceId,
          actorId: actor.userId,
          action: "api_key.created",
          targetKind: "api_key",
          targetId: created.id,
          meta: { name, prefix: minted.prefix, scopes },
        });
        return created;
      },
      { maxWait: 5_000, timeout: 10_000 },
    );
    const creator = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { id: true, name: true } });
    return { ...toDto({ ...(row as KeyRow), createdBy: creator }, now), key: minted.key };
  }

  /** Revokes a key at once (idempotent). A foreign or unknown id is 404. */
  async revoke(workspaceId: string, actor: Actor, id: string): Promise<{ ok: true }> {
    const row = await this.prisma.apiKey.findFirst({ where: { id, workspaceId }, select: { id: true, revokedAt: true, prefix: true } });
    if (!row) throw apiKeyError("api_keys.not_found");
    if (!row.revokedAt) {
      await this.prisma.$transaction(async (tx) => {
        await tx.apiKey.updateMany({ where: { id, workspaceId, revokedAt: null }, data: { revokedAt: this.now() } });
        await this.audit.record(tx, {
          workspaceId,
          actorId: actor.userId,
          action: "api_key.revoked",
          targetKind: "api_key",
          targetId: id,
          meta: { prefix: row.prefix },
        });
      });
    }
    this.lastWrite.delete(id);
    return { ok: true };
  }

  /**
   * The key behind a `crm_…` bearer, or 401 `api_keys.invalid` (one error for
   * every reason: malformed, unknown, revoked, expired, creator gone). Looks
   * the row up by its sha256 (indexed) and re-compares in constant time.
   * Writes `lastUsedAt` at most once per minute per key.
   */
  async authenticate(raw: string): Promise<AuthenticatedKey> {
    const parsed = parseApiKey(raw);
    if (!parsed) throw apiKeyError("api_keys.invalid");
    const row = await this.prisma.apiKey.findUnique({
      where: { hash: parsed.hash },
      select: { id: true, workspaceId: true, prefix: true, hash: true, scopes: true, createdById: true, expiresAt: true, revokedAt: true },
    });
    if (!row || row.prefix !== parsed.prefix || !sameHash(row.hash, parsed.hash)) throw apiKeyError("api_keys.invalid");
    const now = this.now();
    if (statusOf(row, now) !== "active") throw apiKeyError("api_keys.invalid");
    // Dies with its creator: membership is re-read on every request.
    const member = await this.prisma.workspaceMember.findFirst({
      where: { userId: row.createdById, workspaceId: row.workspaceId },
      select: { userId: true },
    });
    if (!member) throw apiKeyError("api_keys.invalid");

    await this.touch(row.id, now);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      createdById: row.createdById,
      permissions: storedScopesToPermissions(row.scopes),
    };
  }

  /** `lastUsedAt`, throttled to once per LAST_USED_THROTTLE_MS per key. */
  private async touch(id: string, now: Date): Promise<void> {
    const last = this.lastWrite.get(id);
    if (last !== undefined && now.getTime() - last < LAST_USED_THROTTLE_MS) return;
    this.lastWrite.set(id, now.getTime());
    if (this.lastWrite.size > 10_000) {
      const oldest = this.lastWrite.keys().next();
      if (!oldest.done) this.lastWrite.delete(oldest.value);
    }
    try {
      await this.prisma.apiKey.updateMany({ where: { id }, data: { lastUsedAt: now } });
    } catch (e) {
      // Never fail a request over a usage stamp; the key id is not secret.
      this.logger.warn(`lastUsedAt write failed for api key ${id}: ${(e as Error).message}`);
    }
  }
}
