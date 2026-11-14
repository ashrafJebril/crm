import { Logger } from "@nestjs/common";
import { Prisma, type MetaAdsConnection } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { upsertAdSourceFromSync } from "../ad-attribution/ad-referral.service";
import { dayOf, safeTimeZone, todayIn } from "../ad-attribution/ad-range";
import { BACKFILL_DAYS, maxPages, RECENT_DAYS, WINDOW_DAYS } from "./meta-ads.config";
import { MetaAdsGraphClient, MetaAdsGraphError, type InsightRow } from "./meta-ads-graph.client";
import type { MetaAdsNotifier } from "./meta-ads-notifier";

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SPEND = /^\d{1,10}(\.\d{1,6})?$/;

export type SyncOutcome =
  | { result: "ok"; windows: number; rows: number; backfilled: boolean }
  | { result: "partial"; windows: number; rows: number }
  | { result: "rate_limited"; windows: number; rows: number }
  | { result: "parked"; reason: "token_refused" | "account_refused" }
  | { result: "failed"; error: string };

export interface SyncDeps {
  prisma: PrismaService;
  graph: MetaAdsGraphClient;
  notifier: Pick<MetaAdsNotifier, "park">;
  log?: Logger;
  env?: Record<string, string | undefined>;
  /** Elapsed-time source for `deadline` (the scheduler's clock). */
  clock?: () => number;
  /** Stop before any Graph read once `clock()` reaches this (M4). */
  deadline?: number;
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);

type WindowConn = Pick<MetaAdsConnection, "spendBackfilledAt" | "timezone"> &
  Partial<Pick<MetaAdsConnection, "lastSyncedAt" | "connectedAt">>;

/**
 * The first day one run reads, and whether a sync gap was cut at the 90-day
 * cap. First run (no `spendBackfilledAt`): 90 account-local days. Later runs:
 * from the day of the last successful sync (`lastSyncedAt`, else
 * `connectedAt`) minus the 3-day restatement overlap, never fewer than the
 * last 3 days and never more than 90 (final review I2: a reconnect of the
 * same account, a re-armed check or a scheduler outage re-reads every day it
 * missed instead of only the last 3).
 */
export function syncSpan(conn: WindowConn, now: Date): { first: string; today: string; gapCapped: boolean } {
  const tz = safeTimeZone(conn.timezone);
  const today = todayIn(tz, now);
  const floor = addDays(today, -(BACKFILL_DAYS - 1));
  if (!conn.spendBackfilledAt) return { first: floor, today, gapCapped: false };
  const recent = addDays(today, -(RECENT_DAYS - 1));
  const anchor = conn.lastSyncedAt ?? conn.connectedAt ?? null;
  const fromLast = anchor ? addDays(dayOf(anchor, tz), -(RECENT_DAYS - 1)) : recent;
  if (fromLast >= recent) return { first: recent, today, gapCapped: false };
  return fromLast < floor ? { first: floor, today, gapCapped: true } : { first: fromLast, today, gapCapped: false };
}

/**
 * The windows one run reads, newest first, 7 days each: the first run's 90
 * days (13 windows); later, the days since the last successful sync (usually
 * just the last 3, one window). Days are the ad account's (its `timezone`).
 */
export function syncWindows(conn: WindowConn, now: Date): Array<{ since: string; until: string }> {
  const { first, today } = syncSpan(conn, now);
  const out: Array<{ since: string; until: string }> = [];
  for (let until = today; until >= first; until = addDays(until, -WINDOW_DAYS)) {
    const since = addDays(until, -(WINDOW_DAYS - 1));
    out.push({ since: since < first ? first : since, until });
  }
  return out;
}

/**
 * Resume: drop the windows wholly on or after `resumeBefore` (already read
 * by an earlier run) and cut one that straddles it, so a day boundary that
 * shifted the windows never skips the unread part of a window.
 */
export function resumeWindows(windows: Array<{ since: string; until: string }>, resumeBefore: string) {
  return windows
    .filter((w) => w.since < resumeBefore)
    .map((w) => (w.until >= resumeBefore ? { since: w.since, until: addDays(resumeBefore, -1) } : w));
}

/** Spend rows per upsert transaction (M4). */
export const UPSERT_BATCH = 200;

/**
 * One claimed connection's spend sync (Architecture → Spend sync).
 *
 * - **Never retries within a run.** A rate limit stops the run (the next
 *   tick resumes); a refused token or account parks the connection (one
 *   notification); anything else records `sync_failed`.
 * - **Resumable backfill (I1).** While `spendBackfilledAt` is null, the run
 *   starts after the oldest day already written for this account since the
 *   connection was made (`MIN(AdSpendDaily.date)`, `syncedAt >= connectedAt`):
 *   windows are read newest first and each is written whole or not at all, so
 *   every window from the newest down to the one holding that day is done. An
 *   empty window leaves no row, so one between the last written window and
 *   the stop point is read again on resume (one cheap page).
 * - **Gap fill (final review I2).** After the backfill a run reads from the
 *   last successful sync (minus the 3-day overlap, at most 90 days) in the
 *   same 7-day windows, budget, deadline and resume (rows written since
 *   `lastSyncedAt`), so days missed while parked or failing are filled.
 * - **Page budget per window.** A window whose paging reaches
 *   `META_ADS_MAX_PAGES` writes nothing and the run moves on to the next one;
 *   the run ends with `lastSyncError: "partial"`, and those days stay unread
 *   (never filled with 0).
 * - **Deadline (M4).** `deps.deadline` (in `deps.clock` units) is checked
 *   before every Graph read; past it the run stops as `partial` and the next
 *   tick resumes.
 * - Writes are upserts on `AdSpendDaily (adSourceId, date)` in transactions
 *   of `UPSERT_BATCH`, so a re-read replaces a day's spend.
 *
 * `token` is the decrypted token; it is never logged.
 */
export async function syncConnection(
  conn: MetaAdsConnection,
  token: string,
  now: Date,
  deps: SyncDeps,
): Promise<SyncOutcome> {
  const { prisma, graph, notifier } = deps;
  const log = deps.log ?? new Logger("MetaAdsSync");
  const clock = deps.clock ?? (() => Date.now());
  const pastDeadline = () => deps.deadline !== undefined && clock() >= deps.deadline;
  const act = conn.adAccountId;
  const currency = conn.currency;
  if (!act || !currency) {
    // Never invent an account or a currency: a row without them cannot be synced.
    await prisma.metaAdsConnection.updateMany({ where: { id: conn.id, workspaceId: conn.workspaceId }, data: { lastSyncError: "sync_failed" } });
    return { result: "failed", error: "sync_failed" };
  }
  const budget = maxPages(deps.env);
  const adIds = new Map<string, string | null>();
  let rows = 0;
  let done = 0;
  let capped = 0;

  const finish = async (data: Prisma.MetaAdsConnectionUpdateManyMutationInput) => {
    await prisma.metaAdsConnection.updateMany({
      where: { id: conn.id, workspaceId: conn.workspaceId, status: "active", tokenEnc: conn.tokenEnc },
      data,
    });
  };

  try {
    let windows = syncWindows(conn, now);
    // Resume a multi-window run (the backfill, or a gap fill) after the
    // windows an earlier, unfinished run already wrote: those rows were written
    // since the connection was made (backfill) or since the last successful
    // sync (gap fill).
    const writtenSince = !conn.spendBackfilledAt
      ? { gte: conn.connectedAt ?? new Date(0) }
      : windows.length > 1
        ? { gt: conn.lastSyncedAt ?? conn.connectedAt ?? new Date(0) }
        : null;
    if (writtenSince) {
      const oldest = await prisma.adSpendDaily.findFirst({
        where: {
          workspaceId: conn.workspaceId,
          adAccountId: act,
          syncedAt: writtenSince,
          date: { gte: new Date(`${windows[windows.length - 1].since}T00:00:00.000Z`) },
        },
        orderBy: [{ date: "asc" }],
        select: { date: true },
      });
      if (oldest) windows = resumeWindows(windows, oldest.date.toISOString().slice(0, 10));
    }

    for (const w of windows) {
      const batch: InsightRow[] = [];
      let after: string | null = null;
      let pages = 0;
      let full = true;
      do {
        if (pastDeadline()) {
          await finish({ lastSyncError: "partial" });
          return { result: "partial", windows: done, rows };
        }
        if (pages >= budget) {
          full = false;
          break;
        }
        const page = await graph.insights(act, token, { since: w.since, until: w.until, after });
        pages++;
        batch.push(...page.data);
        after = page.after;
      } while (after);
      if (!full) {
        capped++;
        log.warn(`meta ads sync ws=${conn.workspaceId} window ${w.since}..${w.until} skipped: page budget reached`);
        continue;
      }
      rows += await writeWindow(prisma, conn, act, currency, w, batch, adIds, now);
      done++;
    }
  } catch (e) {
    if (!(e instanceof MetaAdsGraphError)) {
      log.warn(`meta ads sync ws=${conn.workspaceId} failed: ${(e as { code?: string })?.code ?? (e as Error)?.name ?? "error"}`);
      await finish({ lastSyncError: "sync_failed" }).catch(() => undefined);
      return { result: "failed", error: "sync_failed" };
    }
    if (e.kind === "token" || e.kind === "refused") {
      const reason = e.kind === "token" ? "token_refused" : "account_refused";
      await notifier.park(conn, reason);
      return { result: "parked", reason };
    }
    if (e.kind === "rate_limit") {
      await finish({ lastSyncError: "rate_limited" });
      return { result: "rate_limited", windows: done, rows };
    }
    await finish({ lastSyncError: "sync_failed" });
    return { result: "failed", error: "sync_failed" };
  }

  const backfilled = !conn.spendBackfilledAt;
  // A gap longer than 90 days was read only from 90 days back: the covered
  // span restarts there (spendBackfilledAt marks its start for the metrics).
  const restart = backfilled || syncSpan(conn, now).gapCapped;
  await finish({
    lastSyncedAt: now,
    lastSyncError: capped ? "partial" : null,
    ...(restart ? { spendBackfilledAt: now } : {}),
  });
  return capped ? { result: "partial", windows: done, rows } : { result: "ok", windows: done, rows, backfilled };
}

/**
 * Upserts one window's rows, newest day first, in transactions of
 * `UPSERT_BATCH`. A window is written whole or not at all: if a batch fails,
 * the earlier batches of this window are undone before the error goes up, so
 * the resume point (`MIN(date)`) never sits in a half-written window. The undo
 * deletes only the rows this run **created** and puts back the prior values of
 * rows that existed before and were only refreshed (final review M6), so a
 * failed refresh never removes good spend. Returns the number of rows written.
 */
async function writeWindow(
  prisma: PrismaService,
  conn: MetaAdsConnection,
  act: string,
  currency: string,
  w: { since: string; until: string },
  batch: InsightRow[],
  adIds: Map<string, string | null>,
  now: Date,
): Promise<number> {
  const byKey = new Map<string, { adSourceId: string; day: string; spend: string }>();
  for (const r of batch) {
    const adId = typeof r.ad_id === "string" ? r.ad_id : null;
    const day = typeof r.date_start === "string" && DAY.test(r.date_start) ? r.date_start : null;
    const spend = typeof r.spend === "string" && SPEND.test(r.spend) ? r.spend : null;
    if (!adId || !day || spend === null || day < w.since || day > w.until) continue;
    if (!adIds.has(adId)) {
      const src = await upsertAdSourceFromSync(prisma, conn.workspaceId, {
        sourceId: adId,
        adAccountId: act,
        adName: name(r.ad_name),
        adSetName: name(r.adset_name),
        campaignName: name(r.campaign_name),
      });
      adIds.set(adId, src?.id ?? null);
    }
    const adSourceId = adIds.get(adId);
    if (!adSourceId) continue;
    byKey.set(`${adSourceId}|${day}`, { adSourceId, day, spend });
  }
  const list = [...byKey.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  if (list.length === 0) return 0;

  // The rows this window may refresh, as they were before this run.
  const prior = new Map<string, { id: string; adAccountId: string; spend: Prisma.Decimal; currency: string; syncedAt: Date }>();
  const keyOf = (adSourceId: string, date: Date) => `${adSourceId}|${date.toISOString().slice(0, 10)}`;
  const adSourceIds = [...new Set(list.map((x) => x.adSourceId))];
  for (let i = 0; i < adSourceIds.length; i += UPSERT_BATCH) {
    const existing = await prisma.adSpendDaily.findMany({
      where: {
        workspaceId: conn.workspaceId,
        adSourceId: { in: adSourceIds.slice(i, i + UPSERT_BATCH) },
        date: { gte: new Date(`${w.since}T00:00:00.000Z`), lte: new Date(`${w.until}T00:00:00.000Z`) },
      },
      select: { id: true, adSourceId: true, date: true, adAccountId: true, spend: true, currency: true, syncedAt: true },
    });
    for (const e of existing) prior.set(keyOf(e.adSourceId, e.date), e);
  }

  const written: Array<{ id: string; key: string }> = [];
  try {
    for (let i = 0; i < list.length; i += UPSERT_BATCH) {
      const rowsOut = await prisma.$transaction(
        list.slice(i, i + UPSERT_BATCH).map((x) => {
          const date = new Date(`${x.day}T00:00:00.000Z`);
          const amount = new Prisma.Decimal(x.spend);
          return prisma.adSpendDaily.upsert({
            where: { adSourceId_date: { adSourceId: x.adSourceId, date } },
            create: { workspaceId: conn.workspaceId, adSourceId: x.adSourceId, adAccountId: act, date, spend: amount, currency, syncedAt: now },
            update: { adAccountId: act, spend: amount, currency, syncedAt: now },
            select: { id: true, adSourceId: true, date: true },
          });
        }),
      );
      for (const r of rowsOut) written.push({ id: r.id, key: keyOf(r.adSourceId, r.date) });
    }
  } catch (e) {
    await undoWindow(prisma, conn.workspaceId, written, prior, now).catch(() => undefined);
    throw e;
  }
  return list.length;
}

/** Undoes the committed batches of a failed window: deletes the rows it created, restores the ones it refreshed. */
async function undoWindow(
  prisma: PrismaService,
  workspaceId: string,
  written: Array<{ id: string; key: string }>,
  prior: Map<string, { id: string; adAccountId: string; spend: Prisma.Decimal; currency: string; syncedAt: Date }>,
  now: Date,
): Promise<void> {
  const created = written.filter((x) => !prior.has(x.key)).map((x) => x.id);
  const refreshed = written.map((x) => prior.get(x.key)).filter((p): p is NonNullable<typeof p> => !!p);
  for (let i = 0; i < created.length; i += UPSERT_BATCH) {
    await prisma.adSpendDaily.deleteMany({ where: { workspaceId, id: { in: created.slice(i, i + UPSERT_BATCH) }, syncedAt: now } });
  }
  for (let i = 0; i < refreshed.length; i += UPSERT_BATCH) {
    await prisma.$transaction(
      refreshed.slice(i, i + UPSERT_BATCH).map((p) =>
        prisma.adSpendDaily.updateMany({
          where: { id: p.id, workspaceId, syncedAt: now },
          data: { adAccountId: p.adAccountId, spend: p.spend, currency: p.currency, syncedAt: p.syncedAt },
        }),
      ),
    );
  }
}

const name = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 512) : null);
