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

/**
 * One claimed connection's spend sync (Architecture → Spend sync). Never
 * retries within a run: a rate limit stops the run (resumed next tick), a
 * refused token or account parks the connection (one notification), anything
 * else records `sync_failed`. A window whose paging hit `META_ADS_MAX_PAGES`
 * is `partial` and writes nothing. Writes are upserts on
 * `AdSpendDaily (adSourceId, date)`, so a re-read replaces a day's spend.
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
  const act = conn.adAccountId;
  const currency = conn.currency;
  if (!act || !currency) {
    // Never invent an account or a currency: a row without them cannot be synced.
    await prisma.metaAdsConnection.updateMany({ where: { id: conn.id, workspaceId: conn.workspaceId }, data: { lastSyncError: "sync_failed" } });
    return { result: "failed", error: "sync_failed" };
  }
  const windows = syncWindows(conn, now);
  const budget = maxPages(deps.env);
  const adIds = new Map<string, string | null>();
  let pagesRead = 0;
  let rows = 0;
  let done = 0;

  const finish = async (data: Prisma.MetaAdsConnectionUpdateManyMutationInput) => {
    await prisma.metaAdsConnection.updateMany({
      where: { id: conn.id, workspaceId: conn.workspaceId, status: "active", tokenEnc: conn.tokenEnc },
      data,
    });
  };

  try {
    for (const w of windows) {
      const batch: InsightRow[] = [];
      let after: string | null = null;
      let capped = false;
      do {
        if (pagesRead >= budget) {
          capped = true;
          break;
        }
        const page = await graph.insights(act, token, { since: w.since, until: w.until, after });
        pagesRead++;
        batch.push(...page.data);
        after = page.after;
      } while (after);
      if (capped) {
        await finish({ lastSyncError: "partial" });
        log.warn(`meta ads sync ws=${conn.workspaceId} partial: page budget reached`);
        return { result: "partial", windows: done, rows };
      }
      rows += await writeWindow(prisma, conn, act, currency, batch, adIds, now);
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
    lastSyncError: null,
    ...(backfilled ? { spendBackfilledAt: now } : {}),
  });
  return { result: "ok", windows: done, rows, backfilled };
}

/** Upserts one window's rows. Returns the number of spend rows written. */
async function writeWindow(
  prisma: PrismaService,
  conn: MetaAdsConnection,
  act: string,
  currency: string,
  batch: InsightRow[],
  adIds: Map<string, string | null>,
  now: Date,
): Promise<number> {
  let n = 0;
  for (const r of batch) {
    const adId = typeof r.ad_id === "string" ? r.ad_id : null;
    const day = typeof r.date_start === "string" && DAY.test(r.date_start) ? r.date_start : null;
    const spend = typeof r.spend === "string" && SPEND.test(r.spend) ? r.spend : null;
    if (!adId || !day || spend === null) continue;
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
    const date = new Date(`${day}T00:00:00.000Z`);
    const amount = new Prisma.Decimal(spend);
    await prisma.adSpendDaily.upsert({
      where: { adSourceId_date: { adSourceId, date } },
      create: { workspaceId: conn.workspaceId, adSourceId, adAccountId: act, date, spend: amount, currency, syncedAt: now },
      update: { adAccountId: act, spend: amount, currency, syncedAt: now },
    });
    n++;
  }
  return n;
}

const name = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 512) : null);
