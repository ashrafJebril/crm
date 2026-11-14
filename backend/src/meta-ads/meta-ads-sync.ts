import { Logger } from "@nestjs/common";
import { Prisma, type MetaAdsConnection } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { upsertAdSourceFromSync } from "../ad-attribution/ad-referral.service";
import { safeTimeZone, todayIn } from "../ad-attribution/ad-range";
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

/**
 * The windows one run reads, newest first. First run (no `spendBackfilledAt`):
 * 90 days in 7-day windows (13). Later runs: the last 3 days (Meta restates
 * recent days). Days are the ad account's (its `timezone`).
 */
export function syncWindows(
  conn: Pick<MetaAdsConnection, "spendBackfilledAt" | "timezone">,
  now: Date,
): Array<{ since: string; until: string }> {
  const today = todayIn(safeTimeZone(conn.timezone), now);
  if (conn.spendBackfilledAt) return [{ since: addDays(today, -(RECENT_DAYS - 1)), until: today }];
  const first = addDays(today, -(BACKFILL_DAYS - 1));
  const out: Array<{ since: string; until: string }> = [];
  for (let until = today; until >= first; until = addDays(until, -WINDOW_DAYS)) {
    const since = addDays(until, -(WINDOW_DAYS - 1));
    out.push({ since: since < first ? first : since, until });
  }
  return out;
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
    if (!conn.spendBackfilledAt) {
      const oldest = await prisma.adSpendDaily.findFirst({
        where: { workspaceId: conn.workspaceId, adAccountId: act, syncedAt: { gte: conn.connectedAt ?? new Date(0) } },
        orderBy: [{ date: "asc" }],
        select: { date: true },
      });
      if (oldest) {
        const resumeBefore = oldest.date.toISOString().slice(0, 10);
        windows = windows.filter((w) => w.until < resumeBefore);
      }
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
  await finish({
    lastSyncedAt: now,
    lastSyncError: capped ? "partial" : null,
    ...(backfilled ? { spendBackfilledAt: now } : {}),
  });
  return capped ? { result: "partial", windows: done, rows } : { result: "ok", windows: done, rows, backfilled };
}

/**
 * Upserts one window's rows, newest day first, in transactions of
 * `UPSERT_BATCH`. A window is written whole or not at all: if a batch
 * fails, the rows this run wrote for the window are removed before the error
 * goes up, so the resume point (`MIN(date)`) never sits in a half-written
 * window. Returns the number of spend rows written.
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
  try {
    for (let i = 0; i < list.length; i += UPSERT_BATCH) {
      await prisma.$transaction(
        list.slice(i, i + UPSERT_BATCH).map((x) => {
          const date = new Date(`${x.day}T00:00:00.000Z`);
          const amount = new Prisma.Decimal(x.spend);
          return prisma.adSpendDaily.upsert({
            where: { adSourceId_date: { adSourceId: x.adSourceId, date } },
            create: { workspaceId: conn.workspaceId, adSourceId: x.adSourceId, adAccountId: act, date, spend: amount, currency, syncedAt: now },
            update: { adAccountId: act, spend: amount, currency, syncedAt: now },
          });
        }),
      );
    }
  } catch (e) {
    await prisma.adSpendDaily
      .deleteMany({
        where: {
          workspaceId: conn.workspaceId,
          adAccountId: act,
          syncedAt: now,
          date: { gte: new Date(`${w.since}T00:00:00.000Z`), lte: new Date(`${w.until}T00:00:00.000Z`) },
        },
      })
      .catch(() => undefined);
    throw e;
  }
  return list.length;
}

const name = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 512) : null);
