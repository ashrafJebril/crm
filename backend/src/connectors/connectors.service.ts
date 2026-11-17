import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SkillsService } from "../skills/skills.service";
import { SKILL_CATALOG, type ConnectorProvider } from "../skills/skill-catalog";
import {
  CONNECTOR_CATALOG,
  CONNECTOR_PROVIDERS,
  CUSTOM_CONNECTORS_MAX,
  PATCH_TOOLS_MAX,
  availability,
  type AuthKind,
} from "./connector-catalog";
import { connectorError } from "./connector-errors";
import {
  applyPatch,
  applyRescan,
  initialTools,
  isExposed,
  storedTools,
  ToolPatchError,
  type StoredTool,
  type ToolAccess,
  type ToolPatchEntry,
} from "./connector-tools";
import { CONNECTOR_UPSTREAM, UpstreamAuthError, type ConnectorUpstream } from "./connector-upstream";
import { ConnectorAgentService } from "./connector-agent.service";
import { ConnectorCredentials, openJson, sealJson } from "./connector-credentials";
import { ConnectorTokenService } from "./connector-token.service";
import { ConnectorStatusService } from "./connector-status.service";
import { parseConnectorUrl, redactedUrl, SafeFetchError } from "./safe-fetch";

export type ConnectorStatus = "pending" | "active" | "needs_reconnect" | "disconnected";

export interface ConnectorSummaryDto {
  id: string;
  provider: string;
  name: string;
  status: string;
  statusReason: string | null;
  accountLabel: string | null;
  agentBound: boolean;
  toolCounts: { on: number; total: number };
  connectedAt: Date | null;
  calls7d: number;
}

export interface ConnectorToolDto {
  name: string;
  title: string | null;
  description: string;
  kind: "read" | "write";
  access: ToolAccess;
  exposed: boolean;
  removed: boolean;
  /** Why a re-scan switched it off (until the owner switches it again). */
  flag: "reclassified" | "description_changed" | "schema_changed" | null;
  /** Custom connectors: the owner marked it read-only. */
  ownerRead: boolean;
}

export interface ConnectorDetailDto extends ConnectorSummaryDto {
  serverHost: string;
  tools: ConnectorToolDto[];
  toolsScannedAt: Date | null;
  sync: unknown[];
  usedBySkills: { key: string; name: { en: string; ar: string } }[];
  version: number;
  /** Custom connectors: header names with masked values ("••••" + last 4). */
  headers: { name: string; value: string }[];
}

export interface ConnectorCardDto {
  provider: string;
  name: { en: string; ar: string };
  description: { en: string; ar: string };
  authKind: AuthKind | null;
  available: boolean;
  unavailableReason: "not_configured" | "coming_soon" | null;
  connectors: ConnectorSummaryDto[];
}

export interface ActivityDto {
  calls: { tool: string; kind: string; outcome: string; errorCode: string | null; source: string; at: Date }[];
  counts7d: { tool: string; ok: number; error: number; refused: number }[];
}

type Row = Prisma.ConnectorGetPayload<Record<string, never>>;

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
/** Headers the CRM sets itself; a custom connector may not override them. */
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "accept", "mcp-session-id", "mcp-protocol-version", "connection", "transfer-encoding"]);
const DAY = 86_400_000;

/** Hardening review: a secret header value is shown as "••••" only. */
function maskSecret(_v: string): string {
  return "••••";
}

/**
 * SP-23 connectors: the gallery, detail, custom connectors (SSRF-guarded
 * check: initialize + tools/list), tool switches, re-scan, the agent switch,
 * activity and disconnect. Every status change goes through `setStatus`,
 * which tells SP-22 skills (`onConnectorChanged`). Secrets (tokens, header
 * values) are never returned or logged.
 */
@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: ConnectorAgentService,
    private readonly credentials: ConnectorCredentials,
    @Inject(CONNECTOR_UPSTREAM) private readonly upstream: ConnectorUpstream,
    @Optional() private readonly skills?: SkillsService,
    // SP-23 Task 2: OAuth token refresh/revoke and the shared status setter.
    @Optional() private readonly tokens?: ConnectorTokenService,
    @Optional() private readonly statuses?: ConnectorStatusService,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────

  private async load(workspaceId: string, id: string, opts: { allowDisconnected?: boolean } = {}): Promise<Row> {
    const row = (await this.prisma.connector.findFirst({ where: { id, workspaceId } })) as Row | null;
    if (!row || (!opts.allowDisconnected && row.status === "disconnected")) throw connectorError("connectors.not_found");
    return row;
  }

  private async calls7d(workspaceId: string, ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const since = new Date(this.now().getTime() - 7 * DAY);
    const groups = (await this.prisma.connectorCall.groupBy({
      by: ["connectorId"],
      where: { workspaceId, connectorId: { in: ids }, at: { gte: since } },
      _count: { _all: true },
    })) as unknown as { connectorId: string; _count: { _all: number } }[];
    return new Map(groups.map((g) => [g.connectorId, g._count._all]));
  }

  summary(row: Row, calls7d = 0): ConnectorSummaryDto {
    const tools = storedTools(row.tools);
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      status: row.status,
      statusReason: row.statusReason ?? null,
      accountLabel: row.accountLabel ?? null,
      agentBound: row.agentBound,
      toolCounts: { on: tools.filter((t) => isExposed(t)).length, total: tools.filter((t) => !t.removedAt).length },
      connectedAt: row.connectedAt ?? null,
      calls7d,
    };
  }

  private async detailOf(row: Row): Promise<ConnectorDetailDto> {
    const calls = await this.calls7d(row.workspaceId, [row.id]);
    let host = "";
    try {
      host = new URL(row.serverUrl).host;
    } catch {
      host = "";
    }
    const headers: { name: string; value: string }[] = [];
    if (row.headersEnc) {
      for (const [name, value] of Object.entries(openJson<Record<string, string>>(row.headersEnc) ?? {})) {
        headers.push({ name, value: maskSecret(String(value)) });
      }
    }
    const installs = await this.prisma.skillInstall
      .findMany({ where: { workspaceId: row.workspaceId }, select: { skillKey: true, status: true } })
      .catch(() => [] as { skillKey: string; status: string }[]);
    const installed = new Map(installs.map((i) => [i.skillKey, i.status]));
    const usedBySkills = SKILL_CATALOG.filter((e) => e.requiredConnector === row.provider)
      .filter((e) => (installed.has(e.key) ? installed.get(e.key) !== "disabled" : e.defaultInstalled))
      .map((e) => ({ key: e.key, name: { en: e.nameEn, ar: e.nameAr } }));
    return {
      ...this.summary(row, calls.get(row.id) ?? 0),
      serverHost: host,
      tools: storedTools(row.tools).map((t) => ({
        name: t.name,
        title: t.title ?? null,
        description: t.description,
        kind: t.kind,
        access: t.access,
        exposed: isExposed(t),
        removed: !!t.removedAt,
        flag: t.flag ?? null,
        ownerRead: t.ownerRead === true,
      })),
      toolsScannedAt: row.toolsScannedAt ?? null,
      sync: [],
      usedBySkills,
      version: row.version,
      headers,
    };
  }

  async list(workspaceId: string): Promise<{ cards: ConnectorCardDto[]; attention: ConnectorSummaryDto[] }> {
    const rows = (await this.prisma.connector.findMany({
      where: { workspaceId, status: { not: "disconnected" } },
      orderBy: { createdAt: "asc" },
    })) as Row[];
    const calls = await this.calls7d(workspaceId, rows.map((r) => r.id));
    const summaries = rows.map((r) => this.summary(r, calls.get(r.id) ?? 0));
    const cards = CONNECTOR_CATALOG.map((e) => ({
      provider: e.provider,
      name: e.name,
      description: e.description,
      authKind: e.authKind,
      ...availability(e),
      connectors: summaries.filter((s) => s.provider === e.provider),
    }));
    return { cards, attention: summaries.filter((s) => s.status === "needs_reconnect") };
  }

  async detail(workspaceId: string, id: string): Promise<ConnectorDetailDto> {
    return this.detailOf(await this.load(workspaceId, id, { allowDisconnected: true }));
  }

  async activity(workspaceId: string, id: string): Promise<ActivityDto> {
    await this.load(workspaceId, id, { allowDisconnected: true });
    const now = this.now().getTime();
    const calls = await this.prisma.connectorCall.findMany({
      where: { workspaceId, connectorId: id, at: { gte: new Date(now - 30 * DAY) } },
      orderBy: { at: "desc" },
      take: 20,
      select: { tool: true, kind: true, outcome: true, errorCode: true, source: true, at: true },
    });
    const week = await this.prisma.connectorCall.findMany({
      where: { workspaceId, connectorId: id, at: { gte: new Date(now - 7 * DAY) } },
      select: { tool: true, outcome: true },
    });
    const counts = new Map<string, { tool: string; ok: number; error: number; refused: number }>();
    for (const c of week) {
      const e = counts.get(c.tool) ?? { tool: c.tool, ok: 0, error: 0, refused: 0 };
      if (c.outcome === "ok" || c.outcome === "error" || c.outcome === "refused") e[c.outcome]++;
      counts.set(c.tool, e);
    }
    return {
      calls: calls.map((c) => ({ tool: c.tool, kind: c.kind, outcome: c.outcome, errorCode: c.errorCode ?? null, source: c.source, at: c.at })),
      counts7d: [...counts.values()].sort((a, b) => a.tool.localeCompare(b.tool)),
    };
  }

  // ── status ───────────────────────────────────────────────────────────

  /**
   * The one place a connector's status changes (Task 2 uses it for
   * needs_reconnect). `from` makes it a compare-and-set; returns whether
   * this call changed it. Skills hear about every change.
   */
  async setStatus(conn: { id: string; workspaceId: string; provider: string }, status: ConnectorStatus, reason: string | null, from?: ConnectorStatus[]): Promise<boolean> {
    if (this.statuses) return this.statuses.set(conn, status, reason, from);
    const res = await this.prisma.connector.updateMany({
      where: { id: conn.id, workspaceId: conn.workspaceId, ...(from ? { status: { in: from } } : { status: { not: status } }) },
      data: { status, statusReason: reason },
    });
    if (res.count > 0) await this.notifySkills(conn.workspaceId, conn.provider);
    return res.count > 0;
  }

  private async notifySkills(workspaceId: string, provider: string): Promise<void> {
    if (!this.skills || !(CONNECTOR_PROVIDERS as readonly string[]).includes(provider)) return;
    try {
      await this.skills.onConnectorChanged(workspaceId, provider as ConnectorProvider);
    } catch (e) {
      this.logger.warn(`skills not updated after a ${provider} connector change: ${(e as Error).message}`);
    }
  }

  // ── custom connectors ───────────────────────────────────────────────

  async createCustom(
    workspaceId: string,
    actorId: string,
    input: { name?: unknown; url?: unknown; headers?: unknown },
  ): Promise<ConnectorDetailDto> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 60) throw connectorError("connectors.check_failed", { reason: "invalid_name" });
    const rawUrl = typeof input.url === "string" ? input.url.trim() : "";
    if (!rawUrl || rawUrl.length > 2048) throw connectorError("connectors.unsafe_url", { reason: "invalid_url" });
    try {
      parseConnectorUrl(rawUrl);
    } catch (e) {
      if (e instanceof SafeFetchError) throw connectorError("connectors.unsafe_url", { reason: e.reason });
      throw e;
    }
    const headers: Record<string, string> = {};
    if (input.headers !== undefined) {
      if (!Array.isArray(input.headers) || input.headers.length > 10) throw connectorError("connectors.check_failed", { reason: "invalid_headers" });
      for (const h of input.headers as unknown[]) {
        const { name: hn, value } = (h ?? {}) as { name?: unknown; value?: unknown };
        if (typeof hn !== "string" || !HEADER_NAME_RE.test(hn) || RESERVED_HEADERS.has(hn.toLowerCase())) throw connectorError("connectors.check_failed", { reason: "invalid_headers" });
        if (typeof value !== "string" || !value || value.length > 4096 || /[\r\n\0]/.test(value)) throw connectorError("connectors.check_failed", { reason: "invalid_headers" });
        headers[hn] = value;
      }
    }
    const authKind: AuthKind = Object.keys(headers).length ? "headers" : "none";
    const headersEnc = authKind === "headers" ? sealJson(headers) : null;

    // A cheap early refusal; the authoritative count is under the lock below.
    if ((await this.customCount(this.prisma, workspaceId)) >= CUSTOM_CONNECTORS_MAX) {
      throw connectorError("connectors.custom_limit", { max: CUSTOM_CONNECTORS_MAX });
    }

    // The check: initialize + tools/list through the SSRF guard.
    const target = { url: rawUrl, headers, trusted: false };
    let upstreamTools;
    try {
      await this.upstream.initialize(target);
      upstreamTools = await this.upstream.listTools(target);
    } catch (e) {
      if (e instanceof SafeFetchError && e.code === "unsafe_url") throw connectorError("connectors.unsafe_url", { reason: e.reason });
      const reason = e instanceof SafeFetchError ? e.reason : e instanceof UpstreamAuthError ? "unauthorized" : "check_failed";
      this.logger.warn(`custom connector check failed for ${redactedUrl(rawUrl)}: ${reason}`);
      throw connectorError("connectors.check_failed", { reason });
    }
    const now = this.now();
    // Hardening review: count and create under a workspace advisory lock, so
    // two concurrent creates cannot both pass the limit.
    const row = (await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('connectors-custom:' || ${workspaceId}))`;
        if ((await this.customCount(tx, workspaceId)) >= CUSTOM_CONNECTORS_MAX) {
          throw connectorError("connectors.custom_limit", { max: CUSTOM_CONNECTORS_MAX });
        }
        return tx.connector.create({
      data: {
        workspaceId,
        provider: "custom",
        name,
        authKind,
        status: "active",
        serverUrl: rawUrl,
        headersEnc,
        // Ruling 5: every tool of a custom connector starts switched off.
        tools: initialTools(upstreamTools, "custom") as unknown as Prisma.InputJsonValue,
        toolsScannedAt: now,
        connectedById: actorId,
        connectedAt: now,
      },
        });
      },
      { maxWait: 10_000, timeout: 15_000 },
    )) as Row;
    await this.provisionQuietly(row);
    await this.notifySkills(workspaceId, "custom");
    return this.detailOf(await this.load(workspaceId, row.id));
  }

  private customCount(db: { connector: Pick<PrismaService["connector"], "count"> }, workspaceId: string): Promise<number> {
    return db.connector.count({ where: { workspaceId, provider: "custom", status: { not: "disconnected" } } });
  }

  /** l registration is best effort at create; the agent switch retries it. */
  private async provisionQuietly(row: Row): Promise<void> {
    try {
      await this.agent.provision(row, { bind: true });
    } catch (e) {
      this.logger.warn(`connector ${row.id} not registered on l yet: ${(e as Error).message}`);
    }
  }

  // ── tool switches and re-scan ───────────────────────────────────────

  async patchTools(
    workspaceId: string,
    id: string,
    input: { version?: unknown; tools?: unknown },
    canManage: boolean,
  ): Promise<ConnectorDetailDto> {
    const row = await this.load(workspaceId, id, { allowDisconnected: true });
    if (row.status === "disconnected") throw connectorError("connectors.disconnected");
    if (!Array.isArray(input.tools) || input.tools.length === 0 || input.tools.length > PATCH_TOOLS_MAX) throw connectorError("connectors.invalid_tools");
    const patch: ToolPatchEntry[] = [];
    for (const t of input.tools as unknown[]) {
      const { name, access, kind } = (t ?? {}) as { name?: unknown; access?: unknown; kind?: unknown };
      if (typeof name !== "string" || (access !== "off" && access !== "read" && access !== "write")) throw connectorError("connectors.invalid_tools");
      if (kind !== undefined && kind !== "read" && kind !== "write") throw connectorError("connectors.invalid_tools");
      patch.push({ name, access, ...(kind ? { kind: kind as "read" | "write" } : {}) });
    }
    if (typeof input.version !== "number" || input.version !== row.version) {
      throw connectorError("connectors.version_conflict", { current: await this.detailOf(row) });
    }
    let next: StoredTool[];
    try {
      next = applyPatch(storedTools(row.tools), patch, canManage, row.provider);
    } catch (e) {
      if (e instanceof ToolPatchError) {
        if (e.code === "write_access_requires_manage") throw connectorError("connectors.write_access_requires_manage", { tool: e.tool });
        if (e.code === "tool_removed") throw connectorError("connectors.tool_removed", { tool: e.tool });
        throw connectorError("connectors.invalid_tools", { tool: e.tool });
      }
      throw e;
    }
    await this.writeTools(row, next);
    return this.detailOf(await this.load(workspaceId, id, { allowDisconnected: true }));
  }

  private async writeTools(row: Row, tools: StoredTool[], extra: Prisma.ConnectorUpdateManyMutationInput = {}): Promise<void> {
    const res = await this.prisma.connector.updateMany({
      where: { id: row.id, workspaceId: row.workspaceId, version: row.version },
      data: { ...extra, tools: tools as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
    });
    if (res.count === 0) {
      const fresh = await this.load(row.workspaceId, row.id, { allowDisconnected: true });
      throw connectorError("connectors.version_conflict", { current: await this.detailOf(fresh) });
    }
  }

  async rescan(workspaceId: string, id: string): Promise<{ detail: ConnectorDetailDto; added: string[]; removed: string[]; changed: string[] }> {
    const row = await this.load(workspaceId, id, { allowDisconnected: true });
    if (row.status === "disconnected") throw connectorError("connectors.disconnected");
    if (row.status !== "active") throw connectorError("connectors.needs_reconnect");
    const target = this.tokens ? await this.tokens.target(row) : await this.credentials.target(row);
    if (!target) throw connectorError("connectors.needs_reconnect");
    let upstreamTools;
    try {
      upstreamTools = await this.upstream.listTools(target);
    } catch (e) {
      if (e instanceof UpstreamAuthError) throw connectorError("connectors.needs_reconnect");
      const reason = e instanceof SafeFetchError ? e.reason : "check_failed";
      throw connectorError("connectors.check_failed", { reason });
    }
    const result = applyRescan(storedTools(row.tools), upstreamTools, row.provider, this.now());
    await this.writeTools(row, result.tools, { toolsScannedAt: this.now() });
    return { detail: await this.detail(workspaceId, id), added: result.added, removed: result.removed, changed: result.changed };
  }

  // ── agent switch and disconnect ─────────────────────────────────────

  async setAgent(workspaceId: string, id: string, bound: boolean): Promise<ConnectorSummaryDto> {
    const row = await this.load(workspaceId, id, { allowDisconnected: true });
    if (row.status === "disconnected") throw connectorError("connectors.disconnected");
    await this.agent.setBound(row, bound);
    const fresh = await this.load(workspaceId, id);
    return this.summary(fresh, (await this.calls7d(workspaceId, [id])).get(id) ?? 0);
  }

  /**
   * Soft disconnect (ruling 7): tokens and secret headers wiped, the proxy
   * token revoked and the l server removed; tool switches and call history
   * kept for a reconnect. A second call is 404.
   */
  async disconnect(workspaceId: string, id: string): Promise<{ ok: true }> {
    const row = await this.load(workspaceId, id);
    await this.agent.remove(row);
    // Ruling 7: revoke at the vendor when it advertises an endpoint (best effort).
    if (this.tokens) await this.tokens.revoke(row).catch(() => undefined);
    await this.prisma.connector.updateMany({
      where: { id, workspaceId },
      data: {
        status: "disconnected",
        statusReason: null,
        tokenEnc: null,
        tokenExpiresAt: null,
        headersEnc: null,
        oauthPendingEnc: null,
        oauthPendingExpiresAt: null,
        disconnectedAt: this.now(),
      },
    });
    await this.notifySkills(workspaceId, row.provider);
    return { ok: true };
  }
}
