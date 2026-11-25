/**
 * SP-20 reply gate: the one question every automatic reply path asks before
 * it answers a customer (the l auto-reply and the kewy-ai bridge in
 * `zernio.service.ts`, the kewy-ai bridge in `whatsapp.service.ts`).
 *
 * The order is fixed and pinned by test:
 *   (1) the emergency stop (`AgentSettings.stoppedAt`, ruling 3)
 *   (2) the conversation's own switch (`aiEnabled`, then `aiPausedAt`)
 *   (3) an excluded tag on the contact (catalog ids resolved to current names)
 *   (4) the working-hours mode, in the workspace timezone
 *
 * The decision is pure (`agentReplyDecision`); `AgentReplyGate` only loads its
 * inputs. Human sends (inbox, campaigns, workflows, templates) never come here.
 */
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AGENT_GATE_CACHE_MS } from "./agent-constants";
import { agentAvailableAt, insideSchedule } from "./agent-hours";

export type GateReason = "stopped" | "conversation_off" | "paused" | "excluded" | "outside_hours" | "within_hours" | "ok";
export interface GateDecision {
  reply: boolean;
  reason: GateReason;
}

export interface GateInput {
  stoppedAt: Date | null;
  /** null when there is no conversation to check (the sandbox preview). */
  conversation: { aiEnabled: boolean; aiPausedAt: Date | null } | null;
  /** The contact carries a tag named in the excluded list. */
  excluded: boolean;
  hoursMode: string;
  schedule: unknown;
  now: Date;
  tz: string;
}

export function agentReplyDecision(input: GateInput): GateDecision {
  if (input.stoppedAt) return { reply: false, reason: "stopped" };
  if (input.conversation) {
    if (!input.conversation.aiEnabled) return { reply: false, reason: "conversation_off" };
    if (input.conversation.aiPausedAt) return { reply: false, reason: "paused" };
  }
  if (input.excluded) return { reply: false, reason: "excluded" };
  if (!agentAvailableAt({ hoursMode: input.hoursMode, schedule: input.schedule }, input.now, input.tz)) {
    // `within` and outside the schedule, or `outside` and inside it.
    return { reply: false, reason: insideSchedule(input.schedule, input.now, input.tz) ? "within_hours" : "outside_hours" };
  }
  return { reply: true, reason: "ok" };
}

/** Contact.tags is a JSON-encoded string array; a malformed value is no tags. */
export function contactTagNames(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** Hours, tags and timezone, cached per process. The stop is never cached. */
interface CachedSettings {
  at: number;
  hoursMode: string;
  schedule: unknown;
  /** Current names of the excluded catalog tags (ids of deleted tags drop out). */
  excludedNames: string[];
  tz: string;
}

/** Per-process cache, shared by every gate instance so a settings save can
 *  clear it (`invalidateAgentGate`). It never holds `stoppedAt`: the stop is
 *  read on every decision, so a stop written by another process applies to
 *  the next message (review I1). */
const CACHE = new Map<string, CachedSettings>();

/** Forget a workspace's cached settings: the next decision re-reads them. */
export function invalidateAgentGate(workspaceId?: string): void {
  if (workspaceId === undefined) CACHE.clear();
  else CACHE.delete(workspaceId);
}

export type GatePath = "l_auto_reply" | "zernio_bridge" | "meta_bridge" | "l_origin";

@Injectable()
export class AgentReplyGate {
  private readonly log = new Logger(AgentReplyGate.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The decision for one inbound message. Throws on a read failure. */
  async decide(
    workspaceId: string,
    ctx: { conversationId: string | null; contactId: string | null; now?: Date },
  ): Promise<GateDecision> {
    // The stop is checked first, read fresh on every decision (one unique
    // lookup), and needs nothing else.
    const stop = await this.prisma.agentSettings.findUnique({ where: { workspaceId }, select: { stoppedAt: true } });
    if (stop?.stoppedAt) return { reply: false, reason: "stopped" };
    const settings = await this.settings(workspaceId);
    const conversation = ctx.conversationId
      ? await this.prisma.conversation.findFirst({
          where: { id: ctx.conversationId, workspaceId },
          select: { aiEnabled: true, aiPausedAt: true },
        })
      : null;
    // A conversation id that is not this workspace's is never answered.
    if (ctx.conversationId && !conversation) return { reply: false, reason: "conversation_off" };
    let excluded = false;
    if (settings.excludedNames.length > 0 && ctx.contactId) {
      const contact = await this.prisma.contact.findFirst({
        where: { id: ctx.contactId, workspaceId },
        select: { tags: true },
      });
      const names = new Set(settings.excludedNames);
      excluded = contactTagNames(contact?.tags).some((t) => names.has(t));
    }
    return agentReplyDecision({
      stoppedAt: null,
      conversation: conversation ? { aiEnabled: Boolean(conversation.aiEnabled), aiPausedAt: conversation.aiPausedAt ?? null } : null,
      excluded,
      hoursMode: settings.hoursMode,
      schedule: settings.schedule,
      now: ctx.now ?? new Date(),
      tz: settings.tz,
    });
  }

  /**
   * What the reply paths call: true only when the gate says reply. A failure
   * to decide (a DB error) fails closed: no reply, one warn line.
   */
  async allows(
    workspaceId: string,
    ctx: { conversationId: string | null; contactId: string | null },
    path: GatePath,
  ): Promise<boolean> {
    try {
      const d = await this.decide(workspaceId, ctx);
      if (!d.reply) this.log.debug(`agent reply skipped (${path}): ${d.reason}, conversation ${ctx.conversationId ?? "-"}`);
      return d.reply;
    } catch (err) {
      this.log.warn(
        `agent reply gate failed (${path}) for conversation ${ctx.conversationId ?? "-"}; no reply sent: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private async settings(workspaceId: string): Promise<CachedSettings> {
    const hit = CACHE.get(workspaceId);
    if (hit && Date.now() - hit.at < AGENT_GATE_CACHE_MS) return hit;
    const [row, ws] = await Promise.all([
      this.prisma.agentSettings.findUnique({
        where: { workspaceId },
        select: { hoursMode: true, schedule: true, excludedTagIds: true },
      }),
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } }),
    ]);
    const ids = row?.excludedTagIds ?? [];
    const tags = ids.length
      ? await this.prisma.tag.findMany({ where: { workspaceId, id: { in: ids } }, select: { name: true } })
      : [];
    const next: CachedSettings = {
      at: Date.now(),
      // No row = today's behaviour: always on, nothing excluded.
      hoursMode: row?.hoursMode ?? "always",
      schedule: row?.schedule ?? null,
      excludedNames: tags.map((t) => t.name),
      tz: ws?.timezone ?? "",
    };
    CACHE.set(workspaceId, next);
    return next;
  }
}
