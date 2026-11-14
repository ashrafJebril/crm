import { getHashParam, setHashParam } from "@/lib/hashState";
import type { Tx } from "@/lib/tx";
import type { AdCard, AdsOverview, Lang, MetaAdsConnectionDto, MetaAdsStatus } from "@/lib/types";

/**
 * SP-15 Ads screen view-model. Pure: no React, so the Unknown-vs-0 rules,
 * money formatting, labels, ranges and the OAuth return are unit-tested.
 *
 * Roadmap rule: Unknown is a first-class value. Spend unknown is never 0,
 * never blank and never a dash; cost with nothing started reads
 * "No conversations yet".
 */

// ─── Range presets (`#/ads?range=7d` or `#/ads?range=custom&from=…&to=…`) ───

export type RangePreset = "7d" | "30d" | "90d" | "custom";
export const RANGE_PRESETS: Exclude<RangePreset, "custom">[] = ["7d", "30d", "90d"];
const PRESET_DAYS: Record<Exclude<RangePreset, "custom">, number> = { "7d": 7, "30d": 30, "90d": 90 };

export interface AdsRange {
  preset: RangePreset;
  /** YYYY-MM-DD, only for `custom`. */
  from?: string;
  to?: string;
}

export const DEFAULT_RANGE: AdsRange = { preset: "30d" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (s: string | null | undefined): s is string =>
  !!s && DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Reads the range from the hash; anything malformed falls back to the last 30 days. */
export function parseRange(hash: string): AdsRange {
  const preset = getHashParam(hash, "range");
  const from = getHashParam(hash, "from");
  const to = getHashParam(hash, "to");
  if (preset === "7d" || preset === "30d" || preset === "90d") return { preset };
  if ((preset === "custom" || preset === null) && validDay(from) && validDay(to) && from <= to) {
    return { preset: "custom", from, to };
  }
  return DEFAULT_RANGE;
}

/** Returns the hash with the range written (the default range removes every key). */
export function writeRange(hash: string, r: AdsRange): string {
  let h = hash;
  if (r.preset === "custom" && validDay(r.from) && validDay(r.to)) {
    h = setHashParam(h, "range", "custom");
    h = setHashParam(h, "from", r.from);
    h = setHashParam(h, "to", r.to);
    return h;
  }
  h = setHashParam(h, "range", r.preset === "30d" || r.preset === "custom" ? null : r.preset);
  h = setHashParam(h, "from", null);
  return setHashParam(h, "to", null);
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The API query (`from`/`to`, inclusive days) for a range; presets end today (local day). */
export function rangeToQuery(r: AdsRange, now: Date = new Date()): { from: string; to: string } {
  if (r.preset === "custom" && validDay(r.from) && validDay(r.to)) return { from: r.from, to: r.to };
  const days = PRESET_DAYS[r.preset === "custom" ? "30d" : r.preset];
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return { from: localDay(start), to: localDay(now) };
}

export const rangeQueryString = (q: { from: string; to: string }) =>
  `from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}`;

export function presetLabel(p: RangePreset, tx: Tx): string {
  switch (p) {
    case "7d": return tx("Last 7 days", "آخر 7 أيام");
    case "30d": return tx("Last 30 days", "آخر 30 يومًا");
    case "90d": return tx("Last 90 days", "آخر 90 يومًا");
    default: return tx("Custom", "مخصص");
  }
}

// ─── Money ─────────────────────────────────────────────────────────────────

/**
 * "SAR 30.13" in both languages, always with Latin digits (the code, not a
 * symbol, so two currencies never look alike). The fraction digits follow
 * the currency (JOD has 3). An unknown code is the amount plus the code.
 */
export function formatAdMoney(amount: number, currency: string, lang: Lang): string {
  const code = (currency || "").toUpperCase();
  try {
    const nf = new Intl.NumberFormat(lang === "ar" ? "ar-SA-u-nu-latn" : "en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "code",
    });
    const num = nf
      .formatToParts(amount)
      .filter((p) => p.type !== "currency" && p.type !== "literal")
      .map((p) => p.value)
      .join("")
      .replace(/[‎‏؜]/g, "");
    return `${code} ${num}`;
  } catch {
    return `${amount.toFixed(2)} ${code}`.trim();
  }
}

// ─── Unknown spend and cost ────────────────────────────────────────────────

/**
 * Why spend is unknown: no active connection, the ad is in another (or no
 * known) account, or the range has days the spend sync has not read yet.
 */
export type SpendUnknownReason = "not_connected" | "other_account" | "not_synced";

type RangeCoverage = Pick<AdsOverview["range"], "from" | "to" | "spendCoverage">;

/** The whole range lies in the synced days. A backend without `spendCoverage` counts as synced. */
export function rangeSynced(range: RangeCoverage): boolean {
  const c = range.spendCoverage;
  if (c === undefined) return true;
  return !!c && range.from >= c.from && range.to <= c.to;
}

/**
 * The reason for an Unknown spend: overall (the totals, the chart) when no
 * card is given, else for that card.
 */
export function spendUnknownReason(
  conn: (Pick<MetaAdsConnectionDto, "status"> & Partial<Pick<MetaAdsConnectionDto, "adAccountId">>) | null | undefined,
  range?: RangeCoverage | null,
  card?: Pick<AdCard, "adAccountId"> | null,
): SpendUnknownReason {
  if (conn?.status !== "active") return "not_connected";
  if (card && (!card.adAccountId || card.adAccountId !== conn.adAccountId)) return "other_account";
  if (range && !rangeSynced(range)) return "not_synced";
  return "other_account";
}

export function unknownReasonText(reason: SpendUnknownReason, tx: Tx): string {
  switch (reason) {
    case "not_connected": return tx("Connect Meta Ads to see spend", "اربط إعلانات Meta لعرض الإنفاق");
    case "not_synced": return tx("Spend not synced for these days yet", "لم تتم مزامنة الإنفاق لهذه الأيام بعد");
    default: return tx("This ad isn't in the connected ad account", "هذا الإعلان ليس في الحساب الإعلاني المربوط");
  }
}

/** The empty Overview: no ad conversations in this range, or none ever. */
export function emptyStateText(everReferred: boolean, tx: Tx): string {
  return everReferred
    ? tx("No conversations from ads in this range", "لا محادثات من الإعلانات في هذا النطاق")
    : tx("No conversations from ads yet", "لا محادثات من الإعلانات بعد");
}

export interface FigureView {
  text: string;
  /** Unknown renders muted, with `title` as its reason. */
  unknown: boolean;
  title?: string;
}

/** Spend: an amount (0 is a real amount), or a muted "Unknown" with its reason. */
export function spendView(
  spend: { amount: number; currency: string } | null,
  tx: Tx,
  lang: Lang,
  reason: SpendUnknownReason,
): FigureView {
  if (!spend) return { text: tx("Unknown", "غير معروف"), unknown: true, title: unknownReasonText(reason, tx) };
  return { text: formatAdMoney(spend.amount, spend.currency, lang), unknown: false };
}

/** Cost per conversation: "No conversations yet" when nothing started, Unknown without spend. */
export function costPerConversationView(
  card: Pick<AdCard, "started" | "spend" | "costPerConversation">,
  tx: Tx,
  lang: Lang,
  reason: SpendUnknownReason,
): FigureView {
  if (!card.started) {
    return { text: tx("No conversations yet", "لا محادثات بعد"), unknown: true };
  }
  if (!card.spend) return { text: tx("Unknown", "غير معروف"), unknown: true, title: unknownReasonText(reason, tx) };
  const cost = card.costPerConversation ?? card.spend.amount / card.started;
  return { text: formatAdMoney(cost, card.spend.currency, lang), unknown: false };
}

export interface CurrencyFigure {
  currency: string | null;
  spend: FigureView;
  started: number;
  cost: FigureView;
}

/**
 * The totals strip: one figure per currency (never one sum across
 * currencies). Without any known spend it is a single Unknown figure; an
 * active connection whose account had no ads in range reads 0 in its currency.
 */
export function totalsView(
  o: Pick<AdsOverview, "totals" | "connection"> & { range?: RangeCoverage },
  tx: Tx,
  lang: Lang,
): {
  started: number;
  figures: CurrencyFigure[];
} {
  const reason = spendUnknownReason(o.connection, o.range);
  const figures: CurrencyFigure[] = o.totals.byCurrency.map((t) => ({
    currency: t.currency,
    spend: spendView({ amount: t.spend, currency: t.currency }, tx, lang, reason),
    started: t.started,
    cost: costPerConversationView(
      { started: t.started, spend: { amount: t.spend, currency: t.currency }, costPerConversation: t.costPerConversation },
      tx,
      lang,
      reason,
    ),
  }));
  if (figures.length === 0) {
    const cur = o.connection?.status === "active" ? o.connection.currency : null;
    // A real 0 only when the whole range was synced; otherwise Unknown (not_synced).
    const spend = cur && reason !== "not_synced" ? { amount: 0, currency: cur } : null;
    figures.push({
      currency: cur,
      spend: spendView(spend, tx, lang, reason),
      started: 0,
      cost: costPerConversationView({ started: 0, spend, costPerConversation: null }, tx, lang, reason),
    });
  }
  return { started: o.totals.started, figures };
}

// ─── Labels ────────────────────────────────────────────────────────────────

export interface AdLabel {
  kind: "name" | "headline" | "id";
  /** The name or headline; for `id`, the source id itself. */
  text: string;
  /** "Ad" / "إعلان" before an id label. */
  prefix?: string;
}

const clean = (s: string | null | undefined) => (typeof s === "string" ? s.trim() : "");

/** adName → headline → "Ad <id>". Never blank. */
export function adLabel(card: Pick<AdCard, "adName" | "headline"> & { sourceId?: string | null; id?: string }, tx: Tx): AdLabel {
  const name = clean(card.adName);
  if (name) return { kind: "name", text: name };
  const head = clean(card.headline);
  if (head) return { kind: "headline", text: head };
  const id = clean(card.sourceId) || clean(card.id) || "?";
  return { kind: "id", text: id, prefix: tx("Ad", "إعلان") };
}

export const adLabelText = (l: AdLabel) => (l.kind === "id" ? `${l.prefix} ${l.text}` : l.text);

// ─── Daily series ──────────────────────────────────────────────────────────

export interface DailyIn {
  date: string;
  started: number;
  spend: number | null;
}

export interface Bar {
  /** First and last day of the bar (equal for a one-day bar). */
  from: string;
  to: string;
  started: number;
  /** null when no day in the bar has known spend. */
  spend: number | null;
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Bars for the daily chart: every day between the first and last date (idle
 * days are 0 started, spend 0 when the series has known spend, else null),
 * folded into at most `maxBars` bars of equal day-width. Sums are preserved.
 */
export function dailySeries(daily: DailyIn[], maxBars = 31): Bar[] {
  const rows = daily.filter((d) => validDay(d.date)).sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length === 0) return [];
  const anyKnown = rows.some((d) => d.spend !== null);
  const byDay = new Map(rows.map((d) => [d.date, d]));
  const days: DailyIn[] = [];
  const last = rows[rows.length - 1].date;
  for (let day = rows[0].date; day <= last; day = addDays(day, 1)) {
    const d = byDay.get(day);
    days.push(d ?? { date: day, started: 0, spend: anyKnown ? 0 : null });
    if (days.length > 400) break;
  }
  const width = Math.max(1, Math.ceil(days.length / Math.max(1, maxBars)));
  const out: Bar[] = [];
  for (let i = 0; i < days.length; i += width) {
    const chunk = days.slice(i, i + width);
    const known = chunk.filter((d) => d.spend !== null);
    out.push({
      from: chunk[0].date,
      to: chunk[chunk.length - 1].date,
      started: chunk.reduce((s, d) => s + (d.started || 0), 0),
      spend: known.length ? round4(known.reduce((s, d) => s + (d.spend as number), 0)) : null,
    });
  }
  return out;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** The overview's daily rows for one currency's spend (null = no active connection). */
export function overviewDaily(daily: AdsOverview["daily"], currency: string | null): DailyIn[] {
  return daily.map((d) => ({
    date: d.date,
    started: d.started,
    spend: d.spend === null || !currency ? null : (d.spend[currency] ?? 0),
  }));
}

/** The currencies the overview's daily spend carries, sorted. */
export function dailyCurrencies(daily: AdsOverview["daily"]): string[] {
  const set = new Set<string>();
  for (const d of daily) if (d.spend) for (const c of Object.keys(d.spend)) set.add(c);
  return [...set].sort();
}

// ─── Connection ────────────────────────────────────────────────────────────

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";

export const META_ADS_STATUSES: MetaAdsStatus[] = ["not_connected", "pending", "active", "needs_reconnect", "disconnected"];

export interface ConnectionView {
  status: MetaAdsStatus;
  label: string;
  tone: Tone;
  /** Active, saved, and Meta has not been read yet. */
  firstSyncPending: boolean;
}

export function connectionView(dto: Pick<MetaAdsConnectionDto, "status" | "lastSyncedAt"> | null | undefined, tx: Tx): ConnectionView {
  const status: MetaAdsStatus = dto && META_ADS_STATUSES.includes(dto.status) ? dto.status : "not_connected";
  const base = { status, firstSyncPending: status === "active" && !dto?.lastSyncedAt };
  switch (status) {
    case "active": return { ...base, label: tx("Connected", "مربوط"), tone: "ok" };
    case "pending": return { ...base, label: tx("Choose an ad account", "اختر حسابًا إعلانيًا"), tone: "info" };
    case "needs_reconnect": return { ...base, label: tx("Needs reconnecting", "يحتاج إلى إعادة ربط"), tone: "bad" };
    case "disconnected": return { ...base, label: tx("Disconnected", "غير مربوط"), tone: "muted" };
    default: return { ...base, label: tx("Not connected", "غير مربوط بعد"), tone: "muted" };
  }
}

// ─── OAuth return (`#/ads?tab=connection&metaAds=choose|error&code=…`) ─────

export type OAuthReturn = { kind: "choose" } | { kind: "error"; code: string };

const CODE = /^[a-z_]{1,64}$/;

export function oauthReturn(hash: string): OAuthReturn | null {
  const m = getHashParam(hash, "metaAds");
  if (m === "choose") return { kind: "choose" };
  if (m === "error") {
    const code = getHashParam(hash, "code");
    return { kind: "error", code: code && CODE.test(code) ? code : "unknown" };
  }
  return null;
}

/** The hash without the one-shot OAuth return params (other params are kept). */
export function clearOauthReturn(hash: string): string {
  return setHashParam(setHashParam(hash, "metaAds", null), "code", null);
}

// ─── Tabs and the per-ad page ──────────────────────────────────────────────

export type AdsTab = "overview" | "connection";
export const readTab = (hash: string): AdsTab => (getHashParam(hash, "tab") === "connection" ? "connection" : "overview");

/** Seconds left on the check cooldown (429 `retryAfter`, or `nextAt`). */
export function cooldownSeconds(extra: Record<string, unknown>, now: number = Date.now()): number | null {
  const r = Number(extra.retryAfter);
  if (Number.isFinite(r) && r > 0) return Math.ceil(r);
  const next = typeof extra.nextAt === "string" ? Date.parse(extra.nextAt) : NaN;
  if (Number.isFinite(next) && next > now) return Math.ceil((next - now) / 1000);
  return null;
}
