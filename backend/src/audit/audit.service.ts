import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AUDIT_PAGE } from "../members/members-constants";
import { getWorkspaceContext } from "../common/workspace-context";

export type AuditActorKind = "user" | "system" | "api_key";
export type AuditTargetKind = "member" | "invitation" | "role" | "workspace" | "user" | "api_key" | "webhook";

/** What a writer records. `meta` must never hold a token, code, password or
 *  email body. */
export interface AuditEntry {
  workspaceId: string;
  actorId: string | null;
  actorKind?: AuditActorKind;
  action: string;
  targetKind: AuditTargetKind;
  targetId?: string | null;
  meta?: Record<string, unknown> | null;
}

/** The writer's transaction (or PrismaService): audit rows commit or roll
 *  back with the change they describe (ruling 8). */
export type AuditDb = { auditLog: Pick<PrismaService["auditLog"], "create"> };

export interface AuditEntryDto {
  id: string;
  action: string;
  actor: { id: string; name: string } | null;
  actorKind: string;
  targetKind: string;
  targetId: string | null;
  targetLabel: string | null;
  meta: unknown;
  createdAt: Date;
}

export interface AuditQuery {
  cursor?: string;
  action?: string;
  actorId?: string;
  from?: string;
  to?: string;
}

/** Keys that never belong in audit meta, whatever a caller passes. */
const SECRET_META = /token|password|secret|code|hash|link|body/i;

function cleanMeta(meta: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || SECRET_META.test(k)) continue;
    out[k] = v;
  }
  return out as Prisma.InputJsonValue;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string, string];
    const createdAt = new Date(at);
    if (typeof id !== "string" || Number.isNaN(createdAt.getTime())) throw new Error("bad");
    return { createdAt, id };
  } catch {
    throw new BadRequestException("Invalid cursor");
  }
}

function parseDate(v: string | undefined, field: string): Date | undefined {
  if (v === undefined || v === "") return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${field}`);
  return d;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Writes one audit row through `db` (pass the writer's transaction). */
  async record(db: AuditDb, e: AuditEntry): Promise<void> {
    // SP-27: a write made through an API key is recorded as the key's (its
    // creator is the actorId), with the key id in meta.
    const apiKeyId = getWorkspaceContext()?.apiKeyId;
    const viaKey = !!apiKeyId && (e.actorKind === undefined || e.actorKind === "user");
    await db.auditLog.create({
      data: {
        workspaceId: e.workspaceId,
        actorId: e.actorId,
        actorKind: viaKey ? "api_key" : (e.actorKind ?? "user"),
        action: e.action,
        targetKind: e.targetKind,
        targetId: e.targetId ?? null,
        meta: cleanMeta(viaKey ? { ...(e.meta ?? {}), apiKeyId } : e.meta),
      },
    });
  }

  /** A user-level security event, copied into every workspace the user
   *  belongs to (ruling 8), through the writer's transaction. */
  async recordForUser(
    db: AuditDb & { workspaceMember: Pick<PrismaService["workspaceMember"], "findMany"> },
    userId: string,
    e: Omit<AuditEntry, "workspaceId">,
  ): Promise<void> {
    const memberships = await db.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true } });
    for (const workspaceId of new Set(memberships.map((m) => m.workspaceId))) {
      await this.record(db, { ...e, workspaceId });
    }
  }

  /** One page of the workspace's log, newest first: (createdAt desc, id desc). */
  async list(workspaceId: string, q: AuditQuery): Promise<{ items: AuditEntryDto[]; nextCursor: string | null }> {
    const from = parseDate(q.from, "from");
    const to = parseDate(q.to, "to");
    const and: Prisma.AuditLogWhereInput[] = [{ workspaceId }];
    if (q.action) and.push({ action: q.action });
    if (q.actorId) and.push({ actorId: q.actorId });
    if (from) and.push({ createdAt: { gte: from } });
    if (to) and.push({ createdAt: { lte: to } });
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      and.push({ OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] });
    }
    const rows = await this.prisma.auditLog.findMany({
      where: { AND: and },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: AUDIT_PAGE + 1,
    });
    // Explicit post-check: this model is not tenant-scoped.
    const page = rows.filter((r) => r.workspaceId === workspaceId).slice(0, AUDIT_PAGE);
    const more = rows.length > AUDIT_PAGE;

    const userIds = new Set<string>();
    const invIds = new Set<string>();
    const roleIds = new Set<string>();
    for (const r of page) {
      if (r.actorId) userIds.add(r.actorId);
      if (!r.targetId) continue;
      if (r.targetKind === "member" || r.targetKind === "user") userIds.add(r.targetId);
      if (r.targetKind === "invitation") invIds.add(r.targetId);
      if (r.targetKind === "role") roleIds.add(r.targetId);
    }
    const [users, invitations, roles, ws] = await Promise.all([
      userIds.size
        ? this.prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } })
        : [],
      invIds.size
        ? this.prisma.invitation.findMany({ where: { id: { in: [...invIds] }, workspaceId }, select: { id: true, email: true, workspaceId: true } })
        : [],
      roleIds.size
        ? this.prisma.role.findMany({ where: { id: { in: [...roleIds] }, workspaceId }, select: { id: true, name: true, workspaceId: true } })
        : [],
      page.some((r) => r.targetKind === "workspace")
        ? this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } })
        : null,
    ]);
    const userName = new Map(users.map((u) => [u.id, u.name]));
    const invEmail = new Map(invitations.filter((i) => i.workspaceId === workspaceId).map((i) => [i.id, i.email]));
    const roleName = new Map(roles.filter((r) => r.workspaceId === workspaceId).map((r) => [r.id, r.name]));
    const label = (kind: string, id: string | null): string | null => {
      if (!id) return null;
      if (kind === "member" || kind === "user") return userName.get(id) ?? null;
      if (kind === "invitation") return invEmail.get(id) ?? null;
      if (kind === "role") return roleName.get(id) ?? null;
      if (kind === "workspace") return ws && ws.id === id ? ws.name : null;
      return null;
    };

    const items = page.map((r) => ({
      id: r.id,
      action: r.action,
      actor: r.actorId ? { id: r.actorId, name: userName.get(r.actorId) ?? "" } : null,
      actorKind: r.actorKind,
      targetKind: r.targetKind,
      targetId: r.targetId,
      targetLabel: label(r.targetKind, r.targetId),
      meta: r.meta ?? null,
      createdAt: r.createdAt,
    }));
    const last = page[page.length - 1];
    return { items, nextCursor: more && last ? encodeCursor(last.createdAt, last.id) : null };
  }
}
