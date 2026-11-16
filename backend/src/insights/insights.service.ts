import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import {
  MAX_CONCURRENT_SECTIONS,
  SECTION_MAX_WAIT_MS,
  SECTION_STATEMENT_TIMEOUT,
  sectionTransactionTimeoutMs,
} from "./insights-constants";
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
import type { ResolutionMix, SalesInsights, Section, SupportHeadline, SupportInsights } from "./insights.dto";
import { localDayBounds } from "../activities/buckets";
import { assembleSalesHeadline, salesSections } from "./sales-sections";
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
 * A tiny in-memory concurrency limiter (no dependency): at most `limit` tasks
 * run at once; the rest wait in FIFO order.
 */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= limit) return;
    const start = queue.shift();
    if (!start) return;
    active += 1;
    start();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
}

/**
 * Process-wide: at most MAX_CONCURRENT_SECTIONS insight sections hold a pooled
 * connection at once, however many report loads run concurrently, so a report
 * never starves webhooks and sends of connections (P2024).
 */
export const sectionLimiter = createLimiter(MAX_CONCURRENT_SECTIONS);

export interface SectionOptions {
  /** Statements the section runs; its transaction budget covers each one's
   *  statement_timeout plus a margin. Default 1. */
  statements?: number;
  /** The limiter to queue on (tests); default the process-wide one. */
  limiter?: <R>(task: () => Promise<R>) => Promise<R>;
}

/**
 * Runs one report section in its own transaction with `SET LOCAL
 * statement_timeout` and `jit = off` (Tkana D9), queued on the process-wide
 * section limiter. The transaction budget is statement_timeout × statements
 * plus a margin, so only Postgres's own timeout can cut a section short. A
 * section that times out (Postgres 57014) or fails for any other reason is
 * `unavailable`; the other sections still answer. Nothing is cached
 * (ruling 9). Shared by every SP-11 report (support, sales, home).
 */
export async function runSection<T>(
  db: SectionDb,
  label: string,
  fn: (tx: SectionTx) => Promise<T>,
  logger?: Pick<Logger, "warn">,
  opts: SectionOptions = {},
): Promise<Section<T>> {
  const limit = opts.limiter ?? sectionLimiter;
  try {
    const data = await limit(() =>
      db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${SECTION_STATEMENT_TIMEOUT}'`);
          await tx.$executeRawUnsafe(`SET LOCAL jit = off`);
          return fn(tx);
        },
        { maxWait: SECTION_MAX_WAIT_MS, timeout: sectionTransactionTimeoutMs(opts.statements ?? 1) },
      ),
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

  private section<T>(label: string, fn: (tx: SectionTx) => Promise<T>, statements = 1): Promise<Section<T>> {
    return runSection(this.prisma as unknown as SectionDb, label, fn, this.logger, { statements });
  }

  /** `GET /insights/support`. */
  async support(workspaceId: string, q: SupportQuery, viewer?: Viewer, now: Date = new Date()): Promise<SupportInsights> {
    const { tz } = await this.workspaceLocale(workspaceId);
    const range = parseRange(q.from, q.to, tz, now);
    const channelId = await this.supportChannel(workspaceId, q.channelId);
    const scope = await this.perm.conversationScope(workspaceId, viewer);
    const sections = supportSections(workspaceId, range, scope, { channelId });
    // The headline's six statements each run in their own one-statement
    // transaction (and budget); the headline is unavailable if any of them is.
    const h = sections.headlineParts;
    const [conv, ai, fr, handling, saved, tickets, resolutionMix, peaks, byNumber, topicFriction, team] = await Promise.all([
      this.section("support.headline.conversations", h.conversations),
      this.section("support.headline.aiResolution", h.aiResolution),
      this.section("support.headline.firstResponse", h.firstResponse),
      this.section("support.headline.handling", h.handling),
      this.section("support.headline.timeSaved", h.timeSaved),
      this.section("support.headline.ticketShare", h.ticketShare),
      this.section("support.resolutionMix", sections.resolutionMix),
      this.section("support.peaks", sections.peaks),
      this.section("support.byNumber", sections.byNumber),
      this.section("support.topicFriction", sections.topicFriction),
      this.section("support.team", sections.team, 2),
    ]);
    const headline: Section<SupportHeadline> =
      conv.status === "ok" &&
      ai.status === "ok" &&
      fr.status === "ok" &&
      handling.status === "ok" &&
      saved.status === "ok" &&
      tickets.status === "ok"
        ? { status: "ok", data: assembleHeadline(conv.data, ai.data, fr.data, handling.data, saved.data, tickets.data) }
        : { status: "unavailable" };
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

  /**
   * The sales pipeline P: `pipelineId` (this workspace's, any kind), else the
   * first non-archived `leads` pipeline by creation, else the default
   * pipeline. A foreign or unknown id, or no pipeline at all, is 404
   * `insights.pipeline_not_found`.
   */
  private async salesPipeline(workspaceId: string, raw: unknown) {
    const select = { id: true, name: true, nameAr: true, kind: true } as const;
    if (raw !== undefined && raw !== null && raw !== "") {
      if (typeof raw !== "string") throw insightsError("insights.pipeline_not_found");
      const p = await this.prisma.pipeline.findFirst({ where: { id: raw, workspaceId }, select });
      if (!p) throw insightsError("insights.pipeline_not_found");
      return p;
    }
    const leads = await this.prisma.pipeline.findFirst({
      where: { workspaceId, kind: "leads", archivedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select,
    });
    const p = leads ?? (await this.prisma.pipeline.findFirst({ where: { workspaceId, isDefault: true }, select }));
    if (!p) throw insightsError("insights.pipeline_not_found");
    return p;
  }

  /**
   * `GET /insights/sales`. Every section reads tickets, so a member without
   * `tickets.view` gets every section `forbidden` (the range and pipeline
   * are still validated). Conversation-derived parts run under the viewer's
   * scope inside the SQL.
   */
  async sales(workspaceId: string, q: SalesQuery, viewer?: Viewer, now: Date = new Date()): Promise<SalesInsights> {
    const { tz, lang } = await this.workspaceLocale(workspaceId);
    const range = parseRange(q.from, q.to, tz, now);
    const pipeline = await this.salesPipeline(workspaceId, q.pipelineId);
    const base = { range: { from: range.from, to: range.to, tz: range.tz }, pipeline };
    if (!(await this.perm.viewerCan(workspaceId, viewer, "tickets.view"))) {
      const forbidden = { status: "forbidden" } as const;
      return {
        ...base,
        headline: forbidden,
        distribution: forbidden,
        weekly: forbidden,
        sources: forbidden,
        funnel: forbidden,
        lostReasons: forbidden,
        reps: forbidden,
      };
    }
    const scope = await this.perm.conversationScope(workspaceId, viewer);
    const s = salesSections(workspaceId, range, scope, {
      pipelineId: pipeline.id,
      now,
      todayEnd: localDayBounds(now, range.tz).end,
      lang,
    });
    const h = s.headlineParts;
    const [leads, replied, speed, waiting, won, distribution, weekly, sources, funnel, lostReasons, reps] = await Promise.all([
      this.section("sales.headline.leads", h.leads),
      this.section("sales.headline.replied", h.replied),
      this.section("sales.headline.speed", h.speed),
      this.section("sales.headline.waiting", h.waiting),
      this.section("sales.headline.won", h.won),
      this.section("sales.distribution", s.distribution),
      this.section("sales.weekly", s.weekly),
      this.section("sales.sources", s.sources),
      this.section("sales.funnel", s.funnel),
      this.section("sales.lostReasons", s.lostReasons),
      this.section("sales.reps", s.reps, 2),
    ]);
    const headline: SalesInsights["headline"] =
      leads.status === "ok" && replied.status === "ok" && speed.status === "ok" && waiting.status === "ok" && won.status === "ok"
        ? { status: "ok", data: assembleSalesHeadline(leads.data, replied.data, speed.data, waiting.data, won.data) }
        : { status: "unavailable" };
    return { ...base, headline, distribution, weekly, sources, funnel, lostReasons, reps };
  }
}

export interface SalesQuery {
  from?: unknown;
  to?: unknown;
  pipelineId?: unknown;
}

/** The support sections as functions of a transaction (also used by the DB
 *  spec through the service). */
export function supportSections(ws: string, range: InsightsRange, scope: ConversationScope, opts: SupportOpts) {
  const q = <T>(tx: SectionTx, sql: Prisma.Sql) => tx.$queryRaw<T[]>(sql);
  return {
    /** The headline's statements, one transaction each (see `support`). */
    headlineParts: {
      conversations: async (tx: SectionTx) => one(await q<HeadlineRows["conv"]>(tx, conversationsSql(ws, range, scope, opts))),
      aiResolution: async (tx: SectionTx) => one(await q<HeadlineRows["ai"]>(tx, aiResolutionSql(ws, range, scope, opts))),
      firstResponse: async (tx: SectionTx) => one(await q<HeadlineRows["fr"]>(tx, firstResponseSql(ws, range, scope, opts))),
      handling: async (tx: SectionTx) => one(await q<HeadlineRows["handling"]>(tx, handlingSql(ws, range, scope, opts))),
      timeSaved: async (tx: SectionTx) => one(await q<HeadlineRows["saved"]>(tx, timeSavedSql(ws, range, scope, opts))),
      ticketShare: async (tx: SectionTx) => one(await q<HeadlineRows["tickets"]>(tx, ticketShareSql(ws, range, scope, opts))),
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

/** Rows of the headline's six statements. */
export interface HeadlineRows {
  conv: { conversations: number };
  ai: { decided: number; aiResolved: number };
  fr: { median: number | null; unanswered: number };
  handling: { median: number | null };
  saved: { customerMessages: number };
  tickets: { conversations: number; ticketed: number };
}

/** The headline from its six statements' rows (missing rows read as empty). */
export function assembleHeadline(
  conv: Partial<HeadlineRows["conv"]>,
  ai: Partial<HeadlineRows["ai"]>,
  fr: Partial<HeadlineRows["fr"]>,
  handling: Partial<HeadlineRows["handling"]>,
  saved: Partial<HeadlineRows["saved"]>,
  tickets: Partial<HeadlineRows["tickets"]>,
): SupportHeadline {
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
}
