import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { TicketsService } from "../tickets/tickets.service";
import { SUPPORT_PIPELINE, SUPPORT_STAGES } from "./support-pipeline";

/** No message from either side for this long → the thread is judged. tkana's window. */
const IDLE_MINUTES = Number(process.env.RESOLUTION_IDLE_MINUTES) || 30;
/** Below this the verdict is stored but not acted on (no resolve, no ticket). */
export const MIN_CONFIDENCE = 0.7;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MINUTES = 10;
const BATCH = 20;
/** Only conversations active this recently are scanned. */
const LOOKBACK_DAYS = 7;
/** Newest messages sent to the judge. */
const TRANSCRIPT_LIMIT = 200;

export type Verdict = {
  resolved: boolean;
  reason: string | null;
  confidence: number;
  rationale: string;
  issue_type: "complaint" | "escalation" | "none";
  issue_confidence: number;
  sentiment: "positive" | "neutral" | "negative";
  summary: string;
  ticket_title: string | null;
};

const GENUINE = new Set(["resolved", "customer_requested"]);
const SENDER: Record<string, "customer" | "ai" | "staff"> = { them: "customer", ai: "ai", human: "staff" };

/**
 * Conversation resolution, the CRM half (no Inngest: a one-minute cron).
 *
 * The CRM holds the whole transcript — every channel and speaker — so it
 * decides WHEN; Kewy AI (l) decides WHAT: POST /webhooks/{endpoint}/resolution
 * with the workspace's own endpoint secret. Per tkana's Resolution Framework:
 *   - judged once no message has arrived for IDLE_MINUTES (every new message
 *     re-arms it — the debounce is "newest message older than the window");
 *   - acted on only at ≥ MIN_CONFIDENCE;
 *   - a customer writing again clears the verdict ("reopen").
 * A complaint or escalation opens one ticket per conversation in the Support
 * pipeline; an escalation also flags the conversation.
 */
@Injectable()
export class ConversationResolutionService {
  private readonly log = new Logger(ConversationResolutionService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly realtime: RealtimeService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    if (!process.env.L_API_URL || this.running) return;
    this.running = true;
    try {
      await this.reopenAnswered();
      for (const row of await this.due()) {
        await this.judge(row.id, row.workspaceId, row.lastAt);
      }
    } catch (e) {
      this.log.warn(`resolution sweep failed: ${msg(e)}`);
    } finally {
      this.running = false;
    }
  }

  /** The customer wrote after the verdict: it no longer describes the thread. */
  async reopenAnswered(): Promise<number> {
    return this.prisma.raw.$executeRaw`
      UPDATE "Conversation" c SET
        "resolutionStatus" = NULL, "resolution" = NULL, "resolvedAt" = NULL,
        "resolutionIssue" = NULL, "resolutionConfidence" = NULL, "resolutionSentiment" = NULL,
        "resolutionSummary" = NULL, "resolutionRationale" = NULL
      WHERE c."resolutionStatus" IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM "Message" m
          WHERE m."conversationId" = c.id AND m."from" = 'them' AND m."createdAt" > c."resolutionCheckedAt"
        )`;
  }

  /** Quiet past the window and not yet judged at their newest message (or a failed try to retry). */
  async due(): Promise<Array<{ id: string; workspaceId: string; lastAt: Date }>> {
    return this.prisma.raw.$queryRaw<Array<{ id: string; workspaceId: string; lastAt: Date }>>`
      SELECT c.id, c."workspaceId", lm."lastAt"
      FROM (
        SELECT "conversationId", MAX("createdAt") AS "lastAt"
        FROM "Message"
        WHERE "createdAt" > NOW() - (${LOOKBACK_DAYS}::int * INTERVAL '1 day')
        GROUP BY "conversationId"
      ) lm
      JOIN "Conversation" c ON c.id = lm."conversationId"
      JOIN "Workspace" w ON w.id = c."workspaceId"
      WHERE lm."lastAt" < NOW() - (${IDLE_MINUTES}::int * INTERVAL '1 minute')
        AND c.status <> 'spam'
        AND w."lEndpointId" IS NOT NULL AND w."lEndpointSecret" IS NOT NULL
        AND (
          c."resolutionCheckedAt" IS NULL
          OR c."resolutionCheckedAt" < lm."lastAt"
          OR (c."resolutionError" IS NOT NULL AND c."resolutionAttempts" < ${MAX_ATTEMPTS}
              AND c."resolutionCheckedAt" < NOW() - (${RETRY_AFTER_MINUTES}::int * INTERVAL '1 minute'))
        )
      ORDER BY lm."lastAt" ASC
      LIMIT ${BATCH}`;
  }

  /** Claim, ask l, apply. Never throws. */
  async judge(conversationId: string, workspaceId: string, lastAt: Date): Promise<boolean> {
    try {
      // Claim atomically so two app instances never judge (or ticket) the same thread.
      // A thread with a newer message starts a fresh attempt count.
      const claimed = await this.prisma.raw.$queryRaw<Array<{ id: string }>>`
        UPDATE "Conversation" SET
          "resolutionAttempts" = CASE
            WHEN "resolutionCheckedAt" IS NULL OR "resolutionCheckedAt" < ${lastAt} THEN 1
            ELSE "resolutionAttempts" + 1 END,
          "resolutionCheckedAt" = NOW()
        WHERE id = ${conversationId} AND "workspaceId" = ${workspaceId}
          AND (
            "resolutionCheckedAt" IS NULL OR "resolutionCheckedAt" < ${lastAt}
            OR ("resolutionError" IS NOT NULL AND "resolutionAttempts" < ${MAX_ATTEMPTS}
                AND "resolutionCheckedAt" < NOW() - (${RETRY_AFTER_MINUTES}::int * INTERVAL '1 minute'))
          )
        RETURNING id`;
      if (claimed.length === 0) return false;

      const verdict = await this.ask(conversationId, workspaceId);
      await this.apply(conversationId, workspaceId, verdict);
      return true;
    } catch (e) {
      this.log.warn(`resolution for conversation ${conversationId} failed: ${msg(e)}`);
      await this.prisma.raw.conversation
        .update({ where: { id: conversationId }, data: { resolutionError: msg(e).slice(0, 500) } })
        .catch(() => undefined);
      return false;
    }
  }

  async ask(conversationId: string, workspaceId: string): Promise<Verdict> {
    const [ws, rows] = await Promise.all([
      this.prisma.raw.workspace.findUnique({
        where: { id: workspaceId },
        select: { lEndpointId: true, lEndpointSecret: true },
      }),
      this.prisma.raw.message.findMany({
        where: { conversationId, workspaceId },
        orderBy: { createdAt: "desc" },
        take: TRANSCRIPT_LIMIT,
        select: { from: true, body: true, attach: true, createdAt: true },
      }),
    ]);
    if (!ws?.lEndpointId || !ws.lEndpointSecret) throw new Error("workspace is not linked to Kewy AI");
    const messages = rows
      .reverse()
      .filter((m) => SENDER[m.from])
      .map((m) => ({
        sender: SENDER[m.from],
        body: (m.body?.trim() || (m.attach ? "[attachment]" : "")).slice(0, 8000),
        sent_at: m.createdAt.toISOString(),
      }))
      .filter((m) => m.body);
    if (messages.length === 0) throw new Error("no messages to judge");

    const url = `${process.env.L_API_URL!.replace(/\/+$/, "")}/api/v1/webhooks/${encodeURIComponent(ws.lEndpointId)}/resolution`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": ws.lEndpointSecret },
      body: JSON.stringify({ messages, now: new Date().toISOString(), idle_minutes: IDLE_MINUTES }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`Kewy AI answered HTTP ${res.status}`);
    return (await res.json()) as Verdict;
  }

  async apply(conversationId: string, workspaceId: string, v: Verdict): Promise<void> {
    const ended = v.resolved && !!v.reason && v.confidence >= MIN_CONFIDENCE;
    const issue = v.issue_type !== "none" && v.issue_confidence >= MIN_CONFIDENCE ? v.issue_type : "none";
    const conv = await this.prisma.raw.conversation.update({
      where: { id: conversationId },
      data: {
        resolutionStatus: ended ? (GENUINE.has(v.reason!) ? "resolved" : "closed") : "open",
        resolution: ended ? v.reason : null,
        resolvedAt: ended ? new Date() : null,
        resolutionIssue: issue,
        resolutionConfidence: v.confidence,
        resolutionSentiment: v.sentiment,
        resolutionSummary: v.summary?.slice(0, 2000) ?? null,
        resolutionRationale: v.rationale?.slice(0, 2000) ?? null,
        resolutionError: null,
        resolutionAttempts: 0,
        // Fills the long-unused classifier slot the Inbox already reads.
        ...(issue !== "none" ? { intent: issue } : {}),
        ...(issue === "escalation" ? { escalated: true } : {}),
      },
      select: { id: true, contactId: true, channel: true },
    });

    if (issue !== "none") await this.ensureTicket(workspaceId, conv.id, conv.contactId, issue, v);
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: conv.channel,
      conversationId: conv.id,
      resolution: true,
    });
  }

  /** One open Support ticket per conversation; a second complaint adds nothing. */
  private async ensureTicket(
    workspaceId: string,
    conversationId: string,
    contactId: string,
    issue: "complaint" | "escalation",
    v: Verdict,
  ): Promise<void> {
    const { pipelineId, stageId } = await this.supportPipeline(workspaceId);
    const open = await this.prisma.raw.ticket.findFirst({
      where: { workspaceId, pipelineId, conversationId, closedAt: null },
      select: { id: true },
    });
    if (open) return;
    const label = issue === "escalation" ? "Escalation" : "Complaint";
    const title = (v.ticket_title?.trim() || `${label} from conversation`).slice(0, 120);
    await this.tickets.createTicket(workspaceId, {
      pipelineId,
      stageId,
      contactId,
      conversationId,
      title: `[${label}] ${title}`,
      description: [v.summary, v.rationale && `Kewy AI: ${v.rationale}`].filter(Boolean).join("\n\n"),
    });
  }

  /** The workspace's Support pipeline, created on first use. */
  async supportPipeline(workspaceId: string): Promise<{ pipelineId: string; stageId: string }> {
    const find = () =>
      this.prisma.raw.pipeline.findFirst({
        where: { workspaceId, key: SUPPORT_PIPELINE.key },
        select: { id: true, stages: { where: { key: "open" }, select: { id: true } } },
      });
    let p = await find();
    if (!p) {
      try {
        await this.prisma.raw.pipeline.create({
          data: {
            workspaceId,
            key: SUPPORT_PIPELINE.key,
            name: SUPPORT_PIPELINE.name,
            nameAr: SUPPORT_PIPELINE.nameAr,
            stages: { create: SUPPORT_STAGES.map((s) => ({ ...s, workspaceId })) },
          },
        });
      } catch (e) {
        // Another instance created it first — use theirs.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      }
      p = await find();
    }
    if (!p?.stages[0]) throw new Error("Support pipeline has no open stage");
    return { pipelineId: p.id, stageId: p.stages[0].id };
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
