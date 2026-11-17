import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LAgentSetupService } from "../integrations/l-agent-setup.service";
import { SKILL_CATALOG, catalogEntry, defaultConfig, type SkillCatalog, type SkillKey } from "./skill-catalog";

export const LEGACY_EDITED_ERROR = "legacy prompt section was edited";
const ERROR_MAX = 300;

export type ApplyResult =
  | { status: "applied"; changed: boolean; legacyEdited: SkillKey[] }
  | { status: "not-linked" }
  | { status: "failed"; error: string };

/** A failure message safe to store and show: no token, URL query or secret, ≤ 300 chars. */
export function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(token|key|secret|password)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/\?[^\s]*/g, "")
    .slice(0, ERROR_MAX);
}

/**
 * SP-22: writes the agent's live prompt = the owner's text (untouched) + one
 * delimited block per enabled skill. Every write goes through SP-20's
 * `LAgentSetupService.editPrompt` (per-workspace chain + advisory lock; the
 * R6 settlement), via `applySkillBlocks`; no second lock here. Idempotent:
 * no PUT when nothing changes. Bookkeeping on the ledger: an l failure marks
 * the touched skill `needs_attention`; an edited legacy section marks its
 * skill `needs_attention` with LEGACY_EDITED_ERROR; a success clears both.
 */
@Injectable()
export class AgentPromptService {
  private readonly logger = new Logger(AgentPromptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly setup: LAgentSetupService,
  ) {}

  async apply(workspaceId: string, touched?: SkillKey, catalog: SkillCatalog = SKILL_CATALOG): Promise<ApplyResult> {
    let result: ApplyResult;
    try {
      const r = await this.setup.applySkillBlocks(workspaceId, catalog);
      result = r === "not-linked" ? { status: "not-linked" } : { status: "applied", ...r };
    } catch (err) {
      const error = safeError(err);
      this.logger.warn(`skill prompt apply failed for workspace ${workspaceId}: ${error}`);
      result = { status: "failed", error };
    }
    await this.record(workspaceId, result, touched);
    return result;
  }

  private async record(workspaceId: string, result: ApplyResult, touched?: SkillKey): Promise<void> {
    const now = new Date();
    if (result.status === "failed") {
      if (!touched) return;
      const row = await this.prisma.skillInstall.findFirst({ where: { workspaceId, skillKey: touched } });
      if (row && row.workspaceId === workspaceId) {
        // Only a skill meant to be on becomes needs_attention; a skill being
        // turned off keeps its status and records the error.
        const status = row.status === "enabled" || row.status === "needs_attention" ? "needs_attention" : row.status;
        await this.prisma.skillInstall.update({ where: { id: row.id }, data: { status, lastError: result.error } });
      }
      return;
    }
    if (result.status !== "applied") return;
    for (const key of result.legacyEdited) await this.markLegacyEdited(workspaceId, key);
    // Recovered rows: needs_attention (from an l failure) back to enabled.
    const rows = await this.prisma.skillInstall.findMany({ where: { workspaceId, status: "needs_attention" } });
    for (const row of rows) {
      if (row.workspaceId !== workspaceId || result.legacyEdited.includes(row.skillKey as SkillKey)) continue;
      await this.prisma.skillInstall.update({ where: { id: row.id }, data: { status: "enabled", lastError: null, lastAppliedAt: now } });
    }
    if (touched && !result.legacyEdited.includes(touched)) {
      await this.prisma.skillInstall.updateMany({ where: { workspaceId, skillKey: touched }, data: { lastError: null, lastAppliedAt: now } });
    }
  }

  /** A default skill has no row yet: one is written so the gallery can say so. */
  private async markLegacyEdited(workspaceId: string, key: SkillKey): Promise<void> {
    const entry = catalogEntry(SKILL_CATALOG, key);
    if (!entry) return;
    const existing = await this.prisma.skillInstall.findFirst({ where: { workspaceId, skillKey: key } });
    if (existing && existing.workspaceId === workspaceId) {
      if (existing.status === "enabled" || existing.status === "needs_attention") {
        await this.prisma.skillInstall.update({ where: { id: existing.id }, data: { status: "needs_attention", lastError: LEGACY_EDITED_ERROR } });
      }
      return;
    }
    await this.prisma.skillInstall
      .create({
        data: {
          workspaceId,
          skillKey: key,
          installedVersion: 1,
          status: "needs_attention",
          config: defaultConfig(entry) as object,
          lastError: LEGACY_EDITED_ERROR,
        },
      })
      .catch(() => undefined); // a concurrent apply created it
  }
}
