import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AgentPromptService, LEGACY_EDITED_ERROR } from "./agent-prompt.service";
import { CONNECTOR_PRESENCE, NeverConnected, type ConnectorPresence } from "./connector-presence";
import {
  SKILL_CATALOG,
  catalogEntry,
  defaultConfig,
  type ConfigField,
  type ConnectorProvider,
  type SkillCatalog,
  type SkillEntry,
  type SkillKey,
} from "./skill-catalog";
import { mergeOnUpdate, missingRequired, validateSkillConfig } from "./skill-config";
import { skillError } from "./skill-errors";
import { enabledFromStates, isActive, resolveSkillStates, type EnabledSkills, type SkillRow, type SkillState } from "./skill-state";

/** Nest token for the catalog (specs bind a bumped test catalog). */
export const SKILL_CATALOG_TOKEN = Symbol("SKILL_CATALOG");

export interface SkillDto {
  key: SkillKey;
  version: number;
  name: { en: string; ar: string };
  description: { en: string; ar: string };
  category: SkillEntry["category"];
  tools: { name: string; kind: "read" | "write" }[];
  requiredConnector: { provider: ConnectorProvider; connected: boolean } | null;
  configFields: readonly ConfigField[];
  installed: boolean;
  status: SkillState["status"];
  installedVersion: number | null;
  updateAvailable: boolean;
  needsConfig: boolean;
  config: Record<string, unknown>;
  agents: { slug: string; name: { en: string; ar: string } }[];
  usage: { calls7d: number; calls30d: number; lastUsedAt: string | null };
  lastError: string | null;
  /** Why the skill needs attention: its old prompt section was edited on l
   *  (remove it there; disabling is refused meanwhile), or the last apply failed. */
  attentionReason: "legacy_edited" | "apply_failed" | null;
  /** The ledger row's optimistic-concurrency version (0 when there is no row). */
  rowVersion: number;
}

const legacyEdited = (s: SkillState) => s.status === "needs_attention" && s.lastError === LEGACY_EDITED_ERROR;

const DAY = 86_400_000;
const KEWY_AGENT = { en: "Kewy agent", ar: "وكيل كيوي" };

/**
 * SP-22 skills ledger. Every route is scoped to the JWT workspace; another
 * workspace's rows are never read (explicit workspaceId plus a post-check).
 */
@Injectable()
export class SkillsService {
  private readonly catalog: SkillCatalog;
  private readonly presence: ConnectorPresence;
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly prompts: AgentPromptService,
    @Optional() @Inject(CONNECTOR_PRESENCE) presence?: ConnectorPresence,
    @Optional() @Inject(SKILL_CATALOG_TOKEN) catalog?: SkillCatalog,
  ) {
    this.presence = presence ?? new NeverConnected();
    this.catalog = catalog ?? SKILL_CATALOG;
  }

  private entry(key: string): SkillEntry {
    const e = catalogEntry(this.catalog, key);
    if (!e) throw skillError("skills.unknown");
    return e;
  }

  private async rows(workspaceId: string): Promise<SkillRow[]> {
    const rows = (await this.prisma.skillInstall.findMany({ where: { workspaceId } })) as Array<SkillRow & { workspaceId: string }>;
    return rows.filter((r) => r.workspaceId === workspaceId);
  }

  private async state(workspaceId: string, key: SkillKey): Promise<SkillState> {
    const states = resolveSkillStates(await this.rows(workspaceId), this.catalog);
    return states.find((s) => s.key === key) as SkillState;
  }

  /** The skills whose tools the MCP server builds (one indexed query). */
  async enabledFor(workspaceId: string): Promise<EnabledSkills> {
    return enabledFromStates(resolveSkillStates(await this.rows(workspaceId), this.catalog));
  }

  // ── reads ─────────────────────────────────────────────────────────────

  /** GET /skills: our DB only, no l call. */
  async list(workspaceId: string): Promise<{ skills: SkillDto[]; agentConnected: boolean }> {
    const [ws, rows, usage] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { lWorkspaceId: true, lAgentSlug: true } }),
      this.rows(workspaceId),
      this.usage(workspaceId),
    ]);
    const agent = await this.agentName(workspaceId);
    const states = resolveSkillStates(rows, this.catalog);
    const skills = await Promise.all(states.map((s) => this.dto(workspaceId, s, usage, ws?.lAgentSlug ?? null, agent)));
    return { skills, agentConnected: !!ws?.lWorkspaceId };
  }

  private async agentName(workspaceId: string): Promise<{ en: string; ar: string }> {
    const settings = await (this.prisma as unknown as {
      agentSettings?: { findUnique: (a: object) => Promise<{ nameEn: string | null; nameAr: string | null } | null> };
    }).agentSettings
      ?.findUnique({ where: { workspaceId }, select: { nameEn: true, nameAr: true } })
      .catch(() => null);
    return { en: settings?.nameEn || KEWY_AGENT.en, ar: settings?.nameAr || settings?.nameEn || KEWY_AGENT.ar };
  }

  private async usage(workspaceId: string): Promise<Map<string, { calls7d: number; calls30d: number; lastUsedAt: string | null }>> {
    const now = this.now().getTime();
    const group = (since: number) =>
      this.prisma.agentToolCall.groupBy({
        by: ["skillKey"],
        where: { workspaceId, at: { gte: new Date(since) } },
        _count: { _all: true },
        _max: { at: true },
      }) as unknown as Promise<Array<{ skillKey: string | null; _count: { _all: number }; _max: { at: Date | null } }>>;
    const [d7, d30] = await Promise.all([group(now - 7 * DAY), group(now - 30 * DAY)]);
    const out = new Map<string, { calls7d: number; calls30d: number; lastUsedAt: string | null }>();
    for (const g of d30) {
      if (!g.skillKey) continue;
      out.set(g.skillKey, { calls7d: 0, calls30d: g._count._all, lastUsedAt: g._max.at ? new Date(g._max.at).toISOString() : null });
    }
    for (const g of d7) {
      if (!g.skillKey) continue;
      const cur = out.get(g.skillKey);
      if (cur) cur.calls7d = g._count._all;
    }
    return out;
  }

  private async dto(
    workspaceId: string,
    s: SkillState,
    usage: Map<string, { calls7d: number; calls30d: number; lastUsedAt: string | null }>,
    slug: string | null,
    agent: { en: string; ar: string },
  ): Promise<SkillDto> {
    const e = this.entry(s.key);
    const connected = e.requiredConnector ? await this.presence.isConnected(workspaceId, e.requiredConnector).catch(() => false) : false;
    return {
      key: e.key,
      version: e.version,
      name: { en: e.nameEn, ar: e.nameAr },
      description: { en: e.descriptionEn, ar: e.descriptionAr },
      category: e.category,
      tools: e.tools.map((name) => ({ name, kind: e.writeTools.includes(name) ? "write" : "read" })),
      requiredConnector: e.requiredConnector ? { provider: e.requiredConnector, connected } : null,
      configFields: e.configFields,
      installed: s.installed,
      status: s.status,
      installedVersion: s.installedVersion,
      updateAvailable: s.installed && s.installedVersion !== null && s.installedVersion < e.version,
      needsConfig: s.needsConfig,
      config: s.installed ? s.config : defaultConfig(e),
      agents: isActive(s.status) ? [{ slug: slug ?? "", name: agent }] : [],
      usage: usage.get(e.key) ?? { calls7d: 0, calls30d: 0, lastUsedAt: null },
      lastError: s.lastError,
      attentionReason: s.status !== "needs_attention" ? null : legacyEdited(s) ? "legacy_edited" : "apply_failed",
      rowVersion: s.version,
    };
  }

  private async one(workspaceId: string, key: SkillKey): Promise<SkillDto> {
    const [ws, usage] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { lAgentSlug: true } }),
      this.usage(workspaceId),
    ]);
    return this.dto(workspaceId, await this.state(workspaceId, key), usage, ws?.lAgentSlug ?? null, await this.agentName(workspaceId));
  }

  // ── writes ────────────────────────────────────────────────────────────

  private validate(e: SkillEntry, value: unknown) {
    const r = validateSkillConfig(e.configFields, value);
    if (!r.ok) throw skillError("skills.invalid_config", { errors: r.errors });
    return r.config;
  }

  private async connected(workspaceId: string, e: SkillEntry): Promise<boolean> {
    if (!e.requiredConnector) return true;
    return this.presence.isConnected(workspaceId, e.requiredConnector).catch(() => false);
  }

  /** POST /skills/:key/install */
  async install(workspaceId: string, key: string, input: { config?: unknown }, actorId: string | null): Promise<SkillDto> {
    const e = this.entry(key);
    const s = await this.state(workspaceId, e.key);
    const reinstallDefault = e.defaultInstalled && s.row?.status === "disabled";
    if (s.installed && !reinstallDefault) throw skillError("skills.already_installed");
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { lWorkspaceId: true } });
    if (!ws?.lWorkspaceId) throw skillError("skills.agent_not_connected");
    const config = this.validate(e, input.config ?? {});
    const needsConfig = missingRequired(e.configFields, config).length > 0;
    const status = !(await this.connected(workspaceId, e)) ? "needs_connector" : needsConfig ? "disabled" : "enabled";
    if (s.row?.id) {
      await this.cas(workspaceId, e.key, s.version, { installedVersion: e.version, status, config: config as Prisma.InputJsonValue, needsConfig, lastError: null, installedById: actorId });
    } else {
      try {
        await this.prisma.skillInstall.create({
          data: { workspaceId, skillKey: e.key, installedVersion: e.version, status, config: config as Prisma.InputJsonValue, needsConfig, installedById: actorId },
        });
      } catch (err) {
        if ((err as { code?: string })?.code === "P2002") throw skillError("skills.already_installed");
        throw err;
      }
    }
    if (status === "enabled") await this.prompts.apply(workspaceId, e.key, this.catalog);
    return this.one(workspaceId, e.key);
  }

  /** PATCH /skills/:key {enabled?, config?, version} */
  async patch(workspaceId: string, key: string, input: { enabled?: boolean; config?: unknown; version: number }): Promise<SkillDto> {
    const e = this.entry(key);
    const s = await this.state(workspaceId, e.key);
    if (!s.installed) throw skillError("skills.not_installed");
    if (input.version !== s.version) throw skillError("skills.version_conflict", { current: s.version });
    const config = input.config !== undefined ? this.validate(e, input.config) : s.config;
    const missing = missingRequired(e.configFields, config);
    let status = s.status as string;
    if (input.enabled === true) {
      if (e.requiredConnector && !(await this.connected(workspaceId, e))) {
        throw skillError("skills.connector_required", { provider: e.requiredConnector });
      }
      if (missing.length) throw skillError("skills.config_required", { fields: missing });
      status = "enabled";
    } else if (input.enabled === false) {
      // Review I3: its old instructions are still in the prompt; turning the
      // tools off now would leave the agent describing tools it lacks.
      if (legacyEdited(s)) throw skillError("skills.legacy_edited", { key: e.key });
      status = "disabled";
    }
    const data = {
      status,
      config: config as Prisma.InputJsonValue,
      needsConfig: missing.length > 0,
      ...(s.row ? {} : { installedVersion: s.installedVersion ?? e.version }),
    };
    await this.cas(workspaceId, e.key, s.version, data);
    await this.prompts.apply(workspaceId, e.key, this.catalog);
    return this.one(workspaceId, e.key);
  }

  /** POST /skills/:key/update {version}: keeps the saved config (roadmap acceptance). */
  async update(workspaceId: string, key: string, input: { version: number }): Promise<{ skill: SkillDto; dropped: string[] }> {
    const e = this.entry(key);
    const s = await this.state(workspaceId, e.key);
    if (!s.installed) throw skillError("skills.not_installed");
    if (input.version !== s.version) throw skillError("skills.version_conflict", { current: s.version });
    if ((s.installedVersion ?? e.version) >= e.version) throw skillError("skills.up_to_date");
    const merged = mergeOnUpdate(e.configFields, s.config);
    const status = merged.needsConfig && isActive(s.status) ? "disabled" : s.status;
    await this.cas(workspaceId, e.key, s.version, {
      installedVersion: e.version,
      config: merged.config as Prisma.InputJsonValue,
      needsConfig: merged.needsConfig,
      status,
    });
    await this.prompts.apply(workspaceId, e.key, this.catalog);
    return { skill: await this.one(workspaceId, e.key), dropped: merged.dropped };
  }

  /** POST /skills/:key/retry: re-apply after needs_attention. */
  async retry(workspaceId: string, key: string): Promise<SkillDto> {
    const e = this.entry(key);
    const s = await this.state(workspaceId, e.key);
    if (!s.installed) throw skillError("skills.not_installed");
    await this.prompts.apply(workspaceId, e.key, this.catalog);
    return this.one(workspaceId, e.key);
  }

  /** DELETE /skills/:key: the row goes (config not kept); a default skill is stored as disabled. */
  async uninstall(workspaceId: string, key: string): Promise<{ ok: true }> {
    const e = this.entry(key);
    const s = await this.state(workspaceId, e.key);
    if (!s.installed) throw skillError("skills.not_installed");
    if (legacyEdited(s)) throw skillError("skills.legacy_edited", { key: e.key });
    if (e.defaultInstalled) {
      if (s.row) {
        await this.prisma.skillInstall.updateMany({ where: { workspaceId, skillKey: e.key }, data: { status: "disabled", lastError: null, version: { increment: 1 } } });
      } else {
        await this.prisma.skillInstall
          .create({ data: { workspaceId, skillKey: e.key, installedVersion: 1, status: "disabled", config: defaultConfig(e) as Prisma.InputJsonValue } })
          .catch(async (err: unknown) => {
            if ((err as { code?: string })?.code !== "P2002") throw err;
            await this.prisma.skillInstall.updateMany({ where: { workspaceId, skillKey: e.key }, data: { status: "disabled", version: { increment: 1 } } });
          });
      }
    } else {
      await this.prisma.skillInstall.deleteMany({ where: { workspaceId, skillKey: e.key } });
    }
    await this.prompts.apply(workspaceId, e.key, this.catalog);
    return { ok: true };
  }

  /**
   * SP-23 calls this when a connector connects or disconnects: its skills move
   * between needs_connector and enabled (disabled while config is missing),
   * and the prompt is re-applied when anything changed.
   */
  async onConnectorChanged(workspaceId: string, provider: ConnectorProvider): Promise<void> {
    const keys = this.catalog.filter((e) => e.requiredConnector === provider).map((e) => e.key);
    if (!keys.length) return;
    const connected = await this.presence.isConnected(workspaceId, provider).catch(() => false);
    let changed = false;
    for (const row of await this.rows(workspaceId)) {
      if (!keys.includes(row.skillKey as SkillKey)) continue;
      let next: string | null = null;
      if (connected && row.status === "needs_connector") next = row.needsConfig ? "disabled" : "enabled";
      if (!connected && isActive(row.status as SkillState["status"])) next = "needs_connector";
      if (!next) continue;
      await this.prisma.skillInstall.updateMany({ where: { workspaceId, skillKey: row.skillKey }, data: { status: next, version: { increment: 1 } } });
      changed = true;
    }
    if (changed) await this.prompts.apply(workspaceId, undefined, this.catalog);
  }

  /**
   * Compare-and-set on the row version (409 skills.version_conflict); creates
   * the row for a rowless default skill (version 0).
   */
  private async cas(workspaceId: string, key: SkillKey, expected: number, data: Record<string, unknown>): Promise<void> {
    const res = await this.prisma.skillInstall.updateMany({
      where: { workspaceId, skillKey: key, version: expected },
      data: { ...data, version: { increment: 1 } },
    });
    if (res.count === 1) return;
    const existing = await this.prisma.skillInstall.findFirst({ where: { workspaceId, skillKey: key } });
    if (!existing && expected === 0) {
      const e = this.entry(key);
      try {
        await this.prisma.skillInstall.create({
          data: { workspaceId, skillKey: key, installedVersion: 1, config: defaultConfig(e) as Prisma.InputJsonValue, ...data, version: 1 } as never,
        });
        return;
      } catch (err) {
        if ((err as { code?: string })?.code !== "P2002") throw err;
      }
    }
    const current = (await this.prisma.skillInstall.findFirst({ where: { workspaceId, skillKey: key } }))?.version ?? 0;
    throw skillError("skills.version_conflict", { current });
  }
}
