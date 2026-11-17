/**
 * SP-20 agent settings: identity (names, greetings, tone), working-hours mode
 * and schedule, excluded customers (tag ids), and the persona block on the l
 * agent's prompt.
 *
 *  - One row per workspace, created with the defaults on first read (no row =
 *    today's behaviour: always on, nothing excluded, not stopped).
 *  - Every write checks `version` (409 `agent.version_conflict {current}`)
 *    with a compare-and-set update, then bumps it.
 *  - After the commit, the persona block is published to the l prompt with
 *    `LAgentSetupService.ensure` (which also appends any missing CRM, photos,
 *    booking and knowledge sections: SP-17 ruling 10 carry-over, no bulk
 *    backfill). It runs in the background (review: the save returns with
 *    `publishState: "pending"`) and never fails the save: a failure sets
 *    `publishState: "failed"` and the next save or "Re-sync" retries it.
 *    Runs are serialized per workspace; a run records its outcome only while
 *    the row still has the version it published, so a stale run never
 *    overwrites the state of a newer save.
 *  - "Re-sync" waits for its run and maps an l failure to 502
 *    `agent.resync_failed` (no provider text).
 *  - Tag ids of tags deleted from the catalog are dropped on read and
 *    reported once in `droppedTagIds` (ruling 7).
 */
import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LAgentSetupService } from "../integrations/l-agent-setup.service";
import { isConfigured, validateSchedule, type WeeklySchedule } from "../bookings/schedule";
import { AGENT_TONES, HOURS_MODES, type HoursMode, type PublishState } from "./agent-constants";
import { agentError } from "./agent-errors";
import { invalidateAgentGate } from "./agent-reply-gate";
import type { AgentResyncDto, AgentSettingsDto, PatchAgentSettingsDto } from "./agent-settings.dto";
import { personaBlockText } from "./persona-block";

type Row = {
  id: string;
  workspaceId: string;
  nameEn: string | null;
  nameAr: string | null;
  greeting: string | null;
  greetingAr: string | null;
  tone: string[];
  hoursMode: string;
  schedule: unknown;
  excludedTagIds: string[];
  stoppedAt: Date | null;
  stoppedReason: string | null;
  stoppedById: string | null;
  publishState: string;
  version: number;
};

const trimOrNull = (v: string | undefined | null): string | null => {
  const t = String(v ?? "").trim();
  return t ? t : null;
};

function scheduleOrNull(json: unknown): WeeklySchedule | null {
  if (json === null || json === undefined) return null;
  try {
    return validateSchedule(json);
  } catch {
    return null;
  }
}

@Injectable()
export class AgentSettingsService {
  private readonly log = new Logger(AgentSettingsService.name);
  /** Per-workspace publish chain: one prompt write at a time in this process. */
  private readonly publishing = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly agentSetup?: LAgentSetupService,
  ) {}

  private async row(workspaceId: string): Promise<Row> {
    const found = await this.prisma.agentSettings.findUnique({ where: { workspaceId } });
    if (found) return found as unknown as Row;
    // Created with the defaults on first read; a concurrent first read wins the race harmlessly.
    return (await this.prisma.agentSettings.upsert({
      where: { workspaceId },
      create: { workspaceId },
      update: {},
    })) as unknown as Row;
  }

  async get(workspaceId: string): Promise<AgentSettingsDto> {
    let row = await this.row(workspaceId);
    const ids = row.excludedTagIds ?? [];
    const tags = ids.length
      ? await this.prisma.tag.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, name: true } })
      : [];
    const byId = new Map(tags.map((t) => [t.id, t.name]));
    const droppedTagIds = ids.filter((id) => !byId.has(id));
    if (droppedTagIds.length) {
      // A tag deleted from the catalog leaves the list (no version bump: a
      // cleanup, not an owner's edit). Reported in this response.
      const kept = ids.filter((id) => byId.has(id));
      await this.prisma.agentSettings.updateMany({ where: { workspaceId }, data: { excludedTagIds: kept } });
      row = { ...row, excludedTagIds: kept };
      invalidateAgentGate(workspaceId);
    }
    const [ws, stoppedBy] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true, lWorkspaceId: true } }),
      row.stoppedAt && row.stoppedById
        ? this.prisma.user.findUnique({ where: { id: row.stoppedById }, select: { id: true, name: true } })
        : Promise.resolve(null),
    ]);
    return {
      nameEn: row.nameEn,
      nameAr: row.nameAr,
      greeting: row.greeting,
      greetingAr: row.greetingAr,
      tone: AGENT_TONES.filter((t) => (row.tone ?? []).includes(t)),
      hoursMode: ((HOURS_MODES as readonly string[]).includes(row.hoursMode) ? row.hoursMode : "always") as HoursMode,
      schedule: scheduleOrNull(row.schedule),
      excludedTags: row.excludedTagIds.map((id) => ({ id, name: byId.get(id) as string })),
      droppedTagIds,
      stopped: row.stoppedAt
        ? {
            at: row.stoppedAt.toISOString(),
            reason: row.stoppedReason,
            by: stoppedBy ? { id: stoppedBy.id, name: stoppedBy.name } : null,
          }
        : null,
      timezone: ws?.timezone ?? "Asia/Riyadh",
      publishState: row.publishState as PublishState,
      linked: Boolean(ws?.lWorkspaceId),
      version: row.version,
    };
  }

  async update(workspaceId: string, dto: PatchAgentSettingsDto): Promise<AgentSettingsDto> {
    const row = await this.row(workspaceId);
    if (dto.version !== row.version) throw agentError("agent.version_conflict", { current: row.version });

    const data: Record<string, unknown> = {};
    if (dto.identity) {
      const id = dto.identity;
      const next = {
        nameEn: id.nameEn !== undefined ? trimOrNull(id.nameEn) : row.nameEn,
        nameAr: id.nameAr !== undefined ? trimOrNull(id.nameAr) : row.nameAr,
        greeting: id.greeting !== undefined ? trimOrNull(id.greeting) : row.greeting,
        greetingAr: id.greetingAr !== undefined ? trimOrNull(id.greetingAr) : row.greetingAr,
      };
      if (!next.nameEn && !next.nameAr) throw agentError("agent.name_required");
      Object.assign(data, next);
      if (id.tone !== undefined) {
        const bad = id.tone.filter((t) => !(AGENT_TONES as readonly string[]).includes(t));
        if (bad.length) throw agentError("agent.tone_invalid");
        data.tone = AGENT_TONES.filter((t) => id.tone!.includes(t));
      }
    }
    if (dto.hours) {
      const mode = dto.hours.mode;
      let schedule: WeeklySchedule | null = null;
      const given = dto.hours.schedule !== undefined;
      if (given) {
        try {
          schedule = validateSchedule(dto.hours.schedule);
        } catch (e) {
          const body = (e as { getResponse?: () => unknown }).getResponse?.() as { day?: string | null; reason?: string } | undefined;
          throw agentError("agent.hours_invalid", { day: body?.day ?? null, reason: body?.reason ?? "not_object" });
        }
      }
      if (mode !== "always") {
        const effective = given ? schedule : scheduleOrNull(row.schedule);
        if (!effective || !isConfigured(effective)) throw agentError("agent.hours_empty");
      }
      data.hoursMode = mode;
      // `always` keeps the stored schedule unless a new one is sent.
      if (given) data.schedule = schedule;
    }
    if (dto.audience) {
      const ids = [...new Set(dto.audience.excludedTagIds)];
      if (ids.length) {
        const found = await this.prisma.tag.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true } });
        if (found.length !== ids.length) throw agentError("agent.tag_unknown");
      }
      data.excludedTagIds = ids;
    }

    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { lWorkspaceId: true } });
    const linked = Boolean(ws?.lWorkspaceId) && Boolean(this.agentSetup);
    const won = await this.prisma.agentSettings.updateMany({
      where: { workspaceId, version: row.version },
      data: { ...data, ...(linked ? { publishState: "pending" } : {}), version: { increment: 1 } },
    });
    if (won.count === 0) {
      const now = await this.prisma.agentSettings.findUnique({ where: { workspaceId }, select: { version: true } });
      throw agentError("agent.version_conflict", { current: now?.version ?? row.version });
    }
    invalidateAgentGate(workspaceId);
    if (linked) void this.publishQuietly(workspaceId);
    return this.get(workspaceId);
  }

  /** `POST /agent/settings/resync`: re-run setup and the persona block for this workspace only. */
  async resync(workspaceId: string): Promise<AgentResyncDto> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { lWorkspaceId: true } });
    if (!ws?.lWorkspaceId || !this.agentSetup) return { mcpServer: "not_linked", prompt: "not_linked", persona: "not_linked" };
    let out: Awaited<ReturnType<AgentSettingsService["publish"]>>;
    try {
      out = await this.publish(workspaceId);
    } catch {
      // Logged and recorded as publishState "failed" by publish().
      throw agentError("agent.resync_failed");
    }
    return { mcpServer: out.mcpServer, prompt: out.prompt, persona: out.persona ?? "already-present" };
  }

  /** Resolves when the publish runs queued so far for the workspace have settled (specs, shutdown). */
  async whenPublished(workspaceId: string): Promise<void> {
    await (this.publishing.get(workspaceId) ?? Promise.resolve()).catch(() => undefined);
  }

  /** Never throws: the save already committed. */
  private async publishQuietly(workspaceId: string): Promise<void> {
    try {
      await this.publish(workspaceId);
    } catch {
      // Recorded as publishState "failed" by publish(); retried on the next save or re-sync.
    }
  }

  /** Serialized per workspace; records the outcome in `publishState`. */
  private publish(workspaceId: string) {
    const prev = this.publishing.get(workspaceId) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(async () => {
        const row = await this.row(workspaceId);
        try {
          const result = await this.agentSetup!.ensure(workspaceId, { persona: personaBlockText(row) });
          await this.prisma.agentSettings.updateMany({ where: { workspaceId, version: row.version }, data: { publishState: "published" } });
          return result;
        } catch (err) {
          this.log.warn(
            `agent persona publish failed for workspace ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          await this.prisma.agentSettings
            .updateMany({ where: { workspaceId, version: row.version }, data: { publishState: "failed" } })
            .catch(() => undefined);
          throw err;
        }
      });
    this.publishing.set(workspaceId, run);
    void run.finally(() => {
      if (this.publishing.get(workspaceId) === run) this.publishing.delete(workspaceId);
    }).catch(() => undefined);
    return run;
  }
}
