import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { SECTION_STATEMENT_TIMEOUT, SECTION_TRANSACTION_TIMEOUT_MS } from "./insights-constants";
import { insightsError } from "./insights-errors";
import {
  byNumberRows,
  emptyPeaks,
  hoursSaved,
  peaksFrom,
  ratePct,
  teamRows,
  topicRows,
  wholeSeconds,
  type TeamTotals,
} from "./insights-format";
import { parseRange, type InsightsRange } from "./insights-range";
import type { ConversationScope } from "./insights-scope";
import type { ResolutionMix, Section, SupportHeadline, SupportInsights } from "./insights.dto";
import {
  aiResolutionSql,
  byNumberSql,
  conversationsSql,
  firstResponseSql,
  handlingSql,
  peaksSql,
  resolutionMixSql,
  teamMembersSql,
  teamSql,
  ticketShareSql,
  timeSavedSql,
  topicFrictionSql,
  type SupportOpts,
} from "./support-metrics.sql";

/** What a section may run: raw SQL inside its own transaction. */
export interface SectionTx {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRawUnsafe(query: string): Promise<number>;
}

/** The part of PrismaService the section runner needs. */
export interface SectionDb {
  $transaction<R>(fn: (tx: SectionTx) => Promise<R>, options?: { maxWait?: number; timeout?: number }): Promise<R>;
}

/**
 * Runs one report section in its own transaction with `SET LOCAL
 * statement_timeout` and `jit = off` (Tkana D9). A section that times out
 * (Postgres 57014) or fails for any other reason is `unavailable`; the other
 * sections still answer. Nothing is cached (ruling 9). Shared by every SP-11
 * report (support, sales, home).
 */
export async function runSection<T>(
  db: SectionDb,
  label: string,
  fn: (tx: SectionTx) => Promise<T>,
  logger?: Pick<Logger, "warn">,
): Promise<Section<T>> {
  try {
    const data = await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${SECTION_STATEMENT_TIMEOUT}'`);
        await tx.$executeRawUnsafe(`SET LOCAL jit = off`);
        return fn(tx);
      },
      { maxWait: 5_000, timeout: SECTION_TRANSACTION_TIMEOUT_MS },
    );
    return { status: "ok", data };
  } catch (e) {
    const err = e as { code?: string; meta?: { code?: string }; message?: string };
    const timedOut = err?.code === "57014" || err?.meta?.code === "57014" || /57014|statement timeout/.test(String(err?.message ?? ""));
    logger?.warn(`insights section ${label} unavailable${timedOut ? " (statement timeout)" : ""}: ${String(err?.message ?? e).slice(0, 300)}`);
    return { status: "unavailable" };
  }
}

export interface SupportQuery {
  from?: unknown;
  to?: unknown;
  channelId?: unknown;
}

const one = <T>(rows: T[] | undefined): Partial<T> => (rows && rows[0]) || {};
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly perm: PermissionService,
  ) {}

  /** The workspace's timezone and language (week start, ruling 10). */
  async workspaceLocale(workspaceId: string): Promise<{ tz: string | null; lang: string | null }> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true, lang: true } });
    return { tz: ws?.timezone ?? null, lang: ws?.lang ?? null };
  }

  /** A WhatsApp number of this workspace, or 404 `insights.channel_not_found`
   *  (another workspace's id, an Instagram account, an unknown id). */
  private async supportChannel(workspaceId: string, raw: unknown): Promise<string | null> {
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string") throw insightsError("insights.channel_not_found");
    const ch = await this.prisma.channel.findFirst({ where: { id: raw, workspaceId }, select: { id: true, kind: true } });
    if (!ch || ch.kind !== "whatsapp") throw insightsError("insights.channel_not_found");
    return ch.id;
  }

  private section<T>(label: string, fn: (tx: SectionTx) => Promise<T>): Promise<Section<T>> {
    return runSection(this.prisma as unknown as SectionDb, label, fn, this.logger);
  }

  /** `GET /insights/support`. */
  async support(workspaceId: string, q: SupportQuery, viewer?: Viewer, now: Date = new Date()): Promise<SupportInsights> {
    const { tz } = await this.workspaceLocale(workspaceId);
    const range = parseRange(q.from, q.to, tz, now);
    const channelId = await this.supportChannel(workspaceId, q.channelId);
    const scope = await this.perm.conversationScope(workspaceId, viewer);
    const sections = supportSections(workspaceId, range, scope, { channelId });
    const [headline, resolutionMix, peaks, byNumber, topicFriction, team] = await Promise.all([
      this.section("support.headline", sections.headline),
      this.section("support.resolutionMix", sections.resolutionMix),
      this.section("support.peaks", sections.peaks),
      this.section("support.byNumber", sections.byNumber),
      this.section("support.topicFriction", sections.topicFriction),
      this.section("support.team", sections.team),
    ]);
    return {
      range: { from: range.from, to: range.to, tz: range.tz },
      channelId,
      headline,
      resolutionMix,
      peaks,
      byNumber,
      topicFriction,
      team,
    };
  }
}

/** The support sections as functions of a transaction (also used by the DB
 *  spec through the service). */
export function supportSections(ws: string, range: InsightsRange, scope: ConversationScope, opts: SupportOpts) {
  const q = <T>(tx: SectionTx, sql: Prisma.Sql) => tx.$queryRaw<T[]>(sql);
  return {
    headline: async (tx: SectionTx): Promise<SupportHeadline> => {
      const conv = one(await q<{ conversations: number }>(tx, conversationsSql(ws, range, scope, opts)));
      const ai = one(await q<{ decided: number; aiResolved: number }>(tx, aiResolutionSql(ws, range, scope, opts)));
      const fr = one(await q<{ median: number | null; unanswered: number }>(tx, firstResponseSql(ws, range, scope, opts)));
      const handling = one(await q<{ median: number | null }>(tx, handlingSql(ws, range, scope, opts)));
      const saved = one(await q<{ customerMessages: number }>(tx, timeSavedSql(ws, range, scope, opts)));
      const tickets = one(await q<{ conversations: number; ticketed: number }>(tx, ticketShareSql(ws, range, scope, opts)));
      const decided = num(ai.decided);
      const aiResolved = num(ai.aiResolved);
      const customerMessages = num(saved.customerMessages);
      return {
        conversations: num(conv.conversations),
        decided,
        aiResolved,
        aiResolutionRate: ratePct(aiResolved, decided),
        medianFirstResponseSec: wholeSeconds(fr.median),
        unanswered: num(fr.unanswered),
        medianHandlingSec: wholeSeconds(handling.median),
        timeSaved: { customerMessages, hours: hoursSaved(customerMessages) },
        ticketShare: ratePct(num(tickets.ticketed), num(tickets.conversations)),
      };
    },
    resolutionMix: async (tx: SectionTx): Promise<ResolutionMix> => {
      const mix: ResolutionMix = { ai: 0, human: 0, escalated: 0, closed: 0 };
      for (const r of await q<{ bucket: keyof ResolutionMix; n: number }>(tx, resolutionMixSql(ws, range, scope, opts))) {
        if (r.bucket in mix) mix[r.bucket] = num(r.n);
      }
      return mix;
    },
    peaks: async (tx: SectionTx) => {
      const rows = await q<{ dow: number; hour: number; n: number }>(tx, peaksSql(ws, range, scope, opts));
      return rows.length ? peaksFrom(rows) : emptyPeaks();
    },
    byNumber: async (tx: SectionTx) =>
      byNumberRows(
        await q<{ channelId: string | null; label: string | null; exists: boolean; conversations: number; decided: number; ai: number }>(
          tx,
          byNumberSql(ws, range, scope, opts),
        ),
      ),
    topicFriction: async (tx: SectionTx) =>
      topicRows(await q<{ topic: string; count: number; escalated: number; negative: number }>(tx, topicFrictionSql(ws, range, scope, opts))),
    team: async (tx: SectionTx) => {
      const members = await q<{ userId: string; name: string }>(tx, teamMembersSql(ws));
      const rows = await q<{ key: string; assigned: number; replies: number; resolved: number; median: number | null }>(
        tx,
        teamSql(ws, range, scope, opts),
      );
      const totals = new Map<string, TeamTotals>();
      for (const r of rows) {
        totals.set(r.key, { assigned: num(r.assigned), replies: num(r.replies), resolved: num(r.resolved), median: r.median ?? null });
      }
      return teamRows(members, totals);
    },
  };
}
