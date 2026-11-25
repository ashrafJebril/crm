import { Injectable } from "@nestjs/common";
import type { AdSource, MetaAdsConnection } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { toMetaAdsDto, type MetaAdsConnectionDto } from "../meta-ads/meta-ads-dto";
import { adsError } from "./ad-errors";
import { BACKFILL_DAYS } from "../meta-ads/meta-ads.config";
import { dayOf, resolveDayRange, safeTimeZone, type DayRange } from "./ad-range";
import { attributionTimeZone } from "./ad-sources.service";
import { adImageUrl } from "./ad-source-chip";
import { costPerConversation, dateKey, dateValue, daysBetween, round4 } from "./ads-metrics";

export const OVERVIEW_ADS_MAX = 200;

export interface Money {
  amount: number;
  currency: string;
}

/** One ad on the Ads tab (`GET /ad-sources/overview`) or its page (`GET /ad-sources/:id`, with `daily`). */
export interface AdCard {
  id: string;
  sourceId: string;
  sourceType: string;
  headline: string | null;
  body: string | null;
  adName: string | null;
  adSetName: string | null;
  campaignName: string | null;
  namesFrom: string | null;
  mediaType: string | null;
  imageUrl: string | null;
  sourceUrl: string | null;
  adAccountId: string | null;
  /** All time. */
  firstReferredAt: Date | null;
  lastReferredAt: Date | null;
  /** Distinct conversations with a touch of this ad in the range. */
  started: number;
  /**
   * Null = Unknown: no active connection, the ad is not in the connected
   * account, or the range has days the sync has not read (`spendCoverage`).
   */
  spend: Money | null;
  /** Null when nothing started or the spend is unknown. */
  costPerConversation: number | null;
  daily?: Array<{ date: string; started: number; spend: number | null }>;
}

export interface CurrencyTotal {
  currency: string;
  spend: number;
  /** Conversations started by the ads whose spend is in this currency. */
  started: number;
  costPerConversation: number | null;
}

/** The account days the spend sync has read (inclusive), or null before the first full sync. */
export interface SpendCoverage {
  from: string;
  to: string;
}

export interface AdsOverview {
  range: { from: string; to: string; tz: string; spendCoverage: SpendCoverage | null };
  connection: MetaAdsConnectionDto | null;
  totals: { started: number; byCurrency: CurrencyTotal[] };
  daily: Array<{ date: string; started: number; spend: Record<string, number> | null }>;
  ads: AdCard[];
  totalAds: number;
  /** Any ad was ever referred in this workspace (tells "none in this range" from "none yet"). */
  everReferred: boolean;
}

/** Spend kept in 1/10 000 units, so sums never drift. */
type Units = number;
const toUnits = (d: unknown): Units => Math.round(Number(String(d)) * 10_000);
const fromUnits = (u: Units) => round4(u / 10_000);

interface AdAgg {
  /** conversationId → the day of its first touch in the range. */
  firstDay: Map<string, string>;
  /** currency → day → units. */
  spend: Map<string, Map<string, Units>>;
}

/**
 * SP-15 ad metrics (Architecture → Metrics). Read-only and workspace-scoped.
 *  - `started` = distinct conversations with a touch of the ad in the range;
 *    each counts on the day of its first touch in the range.
 *  - spend = the sum of `AdSpendDaily` of the **active** connection's ad
 *    account; null (Unknown) without an active connection, for an ad of
 *    another account, or when the range has a day outside the synced span
 *    (final review I1: before the first sync, older than the backfill, or
 *    after the last successful sync); `{amount: 0}` for a connected ad Meta
 *    reported no spend for on synced days.
 *  - The headline `totals.started` and `daily[].started` count distinct
 *    conversations (a conversation that touched two ads counts once, on the
 *    day of its first touch in the range); per-ad and per-currency figures
 *    stay per ad.
 *  - Days are in the ad account's timezone when connected, else the workspace's (ruling 8).
 */
@Injectable()
export class AdsMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(workspaceId: string, q: { from?: string; to?: string } = {}, now: Date = new Date()): Promise<AdsOverview> {
    const { range, conn } = await this.context(workspaceId, q, now);
    const active = activeAccount(conn);
    const coverage = spendCoverage(conn, active);
    const covered = rangeCovered(range, coverage);
    const { perAd: aggs, firstDay } = await this.aggregate(workspaceId, range, active, null);
    const ids = [...aggs.keys()];
    const rows = ids.length
      ? await this.prisma.adSource.findMany({ where: { workspaceId, id: { in: ids } } })
      : [];
    const cards = rows.map((r) => card(r, aggs.get(r.id)!, covered ? active : null));

    const totals = new Map<string, { spend: Units; started: number }>();
    for (const c of cards) {
      if (!c.spend) continue;
      const t = totals.get(c.spend.currency) ?? { spend: 0, started: 0 };
      t.spend += Math.round(c.spend.amount * 10_000);
      t.started += c.started;
      totals.set(c.spend.currency, t);
    }
    const byCurrency: CurrencyTotal[] = [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, t]) => ({
        currency,
        spend: fromUnits(t.spend),
        started: t.started,
        costPerConversation: costPerConversation(fromUnits(t.spend), t.started),
      }));

    const startedOn = new Map<string, number>();
    for (const d of firstDay.values()) startedOn.set(d, (startedOn.get(d) ?? 0) + 1);
    const inAccount = new Set(rows.filter((r) => active && r.adAccountId === active.adAccountId).map((r) => r.id));
    const daily = daysBetween(range.from, range.to).map((date) => {
      const started = startedOn.get(date) ?? 0;
      if (!active || !dayCovered(date, coverage)) return { date, started, spend: null };
      const units = new Map<string, Units>(active.currency ? [[active.currency, 0]] : []);
      for (const [id, a] of aggs) {
        if (!inAccount.has(id)) continue;
        for (const [cur, byDay] of a.spend) {
          const u = byDay.get(date);
          if (u !== undefined) units.set(cur, (units.get(cur) ?? 0) + u);
        }
      }
      return { date, started, spend: Object.fromEntries([...units].map(([c, u]) => [c, fromUnits(u)])) };
    });

    cards.sort(
      (a, b) =>
        b.started - a.started ||
        (b.spend?.amount ?? -1) - (a.spend?.amount ?? -1) ||
        (b.lastReferredAt?.getTime() ?? 0) - (a.lastReferredAt?.getTime() ?? 0) ||
        a.id.localeCompare(b.id),
    );
    const everReferred =
      firstDay.size > 0 ||
      !!(await this.prisma.adSource.findFirst({ where: { workspaceId, lastReferredAt: { not: null } }, select: { id: true } }));
    return {
      range: { from: range.from, to: range.to, tz: range.tz, spendCoverage: coverage },
      connection: conn ? toMetaAdsDto(conn, false) : null,
      totals: { started: firstDay.size, byCurrency },
      daily,
      ads: cards.slice(0, OVERVIEW_ADS_MAX),
      totalAds: cards.length,
      everReferred,
    };
  }

  /** `GET /ad-sources/:id`: one ad's card with `daily`. 404 `ads.not_found` for a foreign or missing id. */
  async detail(workspaceId: string, id: string, q: { from?: string; to?: string } = {}, now: Date = new Date()): Promise<AdCard> {
    const ad = await this.prisma.adSource.findFirst({ where: { id, workspaceId } });
    if (!ad) throw adsError("ads.not_found");
    const { range, conn } = await this.context(workspaceId, q, now);
    const active = activeAccount(conn);
    const coverage = spendCoverage(conn, active);
    const agg = (await this.aggregate(workspaceId, range, active, ad.id)).perAd.get(ad.id) ?? emptyAgg();
    const c = card(ad, agg, rangeCovered(range, coverage) ? active : null);
    // Per day: known on the synced days when the ad's spend can be known at all.
    const cur = spendOf(ad, agg, active)?.currency ?? null;
    c.daily = daysBetween(range.from, range.to).map((date) => {
      let started = 0;
      for (const d of agg.firstDay.values()) if (d === date) started++;
      const known = cur !== null && dayCovered(date, coverage);
      return { date, started, spend: known ? fromUnits(agg.spend.get(cur)?.get(date) ?? 0) : null };
    });
    return c;
  }

  private async context(workspaceId: string, q: { from?: string; to?: string }, now: Date) {
    const tz = await attributionTimeZone(this.prisma, workspaceId);
    const range = resolveDayRange(q, tz, now);
    const conn = await this.prisma.metaAdsConnection.findUnique({ where: { workspaceId } });
    return { range, conn };
  }

  /** Touches and spend in the range, per ad (only `adId` when given). */
  private async aggregate(
    workspaceId: string,
    range: DayRange,
    active: ActiveAccount | null,
    adId: string | null,
  ): Promise<{ perAd: Map<string, AdAgg>; firstDay: Map<string, string> }> {
    const out = new Map<string, AdAgg>();
    /** conversationId -> the day of its first touch (any ad) in the range. */
    const firstDay = new Map<string, string>();
    const get = (id: string) => {
      let a = out.get(id);
      if (!a) out.set(id, (a = emptyAgg()));
      return a;
    };
    const touches = await this.prisma.adReferral.findMany({
      where: { workspaceId, referredAt: { gte: range.start, lt: range.end }, ...(adId ? { adSourceId: adId } : {}) },
      orderBy: [{ referredAt: "asc" }, { id: "asc" }],
      select: { adSourceId: true, conversationId: true, referredAt: true },
    });
    for (const t of touches) {
      const a = get(t.adSourceId);
      const day = dayOf(t.referredAt, range.tz);
      if (!a.firstDay.has(t.conversationId)) a.firstDay.set(t.conversationId, day);
      if (!firstDay.has(t.conversationId)) firstDay.set(t.conversationId, day);
    }
    if (active) {
      const spend = await this.prisma.adSpendDaily.findMany({
        where: {
          workspaceId,
          adAccountId: active.adAccountId,
          date: { gte: dateValue(range.from), lte: dateValue(range.to) },
          ...(adId ? { adSourceId: adId } : {}),
        },
        select: { adSourceId: true, date: true, spend: true, currency: true },
      });
      for (const s of spend) {
        const byDay = get(s.adSourceId).spend;
        const m = byDay.get(s.currency) ?? new Map<string, Units>();
        const k = dateKey(s.date);
        m.set(k, (m.get(k) ?? 0) + toUnits(s.spend));
        byDay.set(s.currency, m);
      }
    }
    return { perAd: out, firstDay };
  }
}

interface ActiveAccount {
  adAccountId: string;
  currency: string | null;
}

function activeAccount(conn: MetaAdsConnection | null): ActiveAccount | null {
  return conn?.status === "active" && conn.adAccountId && conn.tokenEnc ? { adAccountId: conn.adAccountId, currency: conn.currency } : null;
}

const emptyAgg = (): AdAgg => ({ firstDay: new Map(), spend: new Map() });

const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The account days the spend sync has read: from the backfill's first day
 * (90 days up to `spendBackfilledAt`) to the day of the last successful sync,
 * in the account's timezone (the days `AdSpendDaily` is keyed by). The sync
 * fills gaps since the last success, so the span is contiguous. Only a run
 * that wrote every window it read sets these two fields: a run that stopped
 * at a window over the page budget leaves them as they were, so unread days
 * are never inside the span (SP-15 live F1). Null without
 * an active connection or before the first full sync.
 */
export function spendCoverage(
  conn: Pick<MetaAdsConnection, "spendBackfilledAt" | "lastSyncedAt" | "timezone"> | null,
  active: ActiveAccount | null,
): SpendCoverage | null {
  if (!active || !conn?.spendBackfilledAt || !conn.lastSyncedAt) return null;
  const tz = safeTimeZone(conn.timezone);
  return { from: shiftDay(dayOf(conn.spendBackfilledAt, tz), -(BACKFILL_DAYS - 1)), to: dayOf(conn.lastSyncedAt, tz) };
}

const dayCovered = (day: string, c: SpendCoverage | null) => !!c && day >= c.from && day <= c.to;
const rangeCovered = (r: { from: string; to: string }, c: SpendCoverage | null) => dayCovered(r.from, c) && dayCovered(r.to, c);

/** The ad's spend: Unknown unless it belongs to the active account; per currency, never summed. */
function spendOf(ad: Pick<AdSource, "adAccountId">, agg: AdAgg, active: ActiveAccount | null): Money | null {
  if (!active || ad.adAccountId !== active.adAccountId) return null;
  const currencies = [...agg.spend.keys()];
  // An ad's spend is in its account's one currency; mixed rows cannot be one figure, so it reads Unknown.
  if (currencies.length > 1) return null;
  if (currencies.length === 0) return active.currency ? { amount: 0, currency: active.currency } : null;
  let units = 0;
  for (const u of agg.spend.get(currencies[0])!.values()) units += u;
  return { amount: fromUnits(units), currency: currencies[0] };
}

function card(ad: AdSource, agg: AdAgg, active: ActiveAccount | null): AdCard {
  const spend = spendOf(ad, agg, active);
  const started = agg.firstDay.size;
  return {
    id: ad.id,
    sourceId: ad.sourceId,
    sourceType: ad.sourceType,
    headline: ad.headline ?? null,
    body: ad.body ?? null,
    adName: ad.adName ?? null,
    adSetName: ad.adSetName ?? null,
    campaignName: ad.campaignName ?? null,
    namesFrom: ad.namesFrom ?? null,
    mediaType: ad.mediaType ?? null,
    imageUrl: adImageUrl({ mediaId: ad.mediaId ?? null, mediaUrl: ad.mediaUrl ?? null }),
    sourceUrl: ad.sourceUrl ?? null,
    adAccountId: ad.adAccountId ?? null,
    firstReferredAt: ad.firstReferredAt ?? null,
    lastReferredAt: ad.lastReferredAt ?? null,
    started,
    spend,
    costPerConversation: costPerConversation(spend?.amount ?? null, started),
  };
}
