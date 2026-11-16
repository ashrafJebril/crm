/**
 * SP-11 insights presentation model (pure). Rates are percents with one
 * decimal, medians whole seconds, and an empty denominator is null: shown as
 * "—", never 0. Latin digits in both languages. Server labels that arrive in
 * English (number/member fallbacks, raw source keys) are translated here.
 */
import { encodeJson, setHashParam } from "@/lib/hashState";
import type { Lang } from "@/lib/types";
import type { ByNumberRow, SalesPipelineRef, Section, SpeedBucket, TeamRow } from "./insightsTypes";

export const DASH = "—";
export const NO_DATA: [en: string, ar: string] = ["No data yet", "لا توجد بيانات بعد"];

const NUM = new Intl.NumberFormat("en-US");
const L = (lang: Lang, en: string, ar: string) => (lang === "ar" ? ar : en);

/** A count with Latin digits and grouping. */
export const formatCount = (n: number) => NUM.format(n);

/** A whole-seconds median as "45 s", "12 min", "1 h 5 min", "2 d 3 h"; null → "—". */
export function formatDuration(sec: number | null | undefined, lang: Lang): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return DASH;
  const s = Math.max(0, Math.round(sec));
  const u = {
    s: L(lang, "s", "ث"),
    m: L(lang, "min", "د"),
    h: L(lang, "h", "س"),
    d: L(lang, "d", "ي"),
  };
  if (s < 60) return `${s} ${u.s}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} ${u.m}`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} ${u.h} ${r} ${u.m}` : `${h} ${u.h}`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.round((m % 1440) / 60);
  return h ? `${d} ${u.d} ${h} ${u.h}` : `${d} ${u.d}`;
}

/** A one-decimal percent as "37.5%" (whole numbers keep ".0" out); null → "—". */
export function formatRate(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return DASH;
  return `${NUM.format(Math.round(pct * 10) / 10)}%`;
}

/** Hours saved, one decimal: "12.5 h" / "12.5 س". */
export const formatHours = (h: number, lang: Lang) => `${NUM.format(Math.round(h * 10) / 10)} ${L(lang, "h", "س")}`;

export type SectionView<T> = { kind: "ok"; data: T } | { kind: "unavailable" } | { kind: "hidden" };

/** ok → render; unavailable → a visible "couldn't load" state; forbidden (or missing) → hide. */
export function sectionView<T>(s: Section<T> | null | undefined): SectionView<T> {
  if (!s || s.status === "forbidden") return { kind: "hidden" };
  if (s.status === "unavailable") return { kind: "unavailable" };
  return { kind: "ok", data: s.data };
}

export const UNAVAILABLE_COPY: [en: string, ar: string] = [
  "This part couldn't be calculated right now. Try again in a moment.",
  "تعذّر حساب هذا الجزء الآن. حاول مجددًا بعد قليل.",
];

// ── peaks (7 × 24, row 0 = Sunday) ──────────────────────────────────────

/** First day of the week (0 = Sunday): Sunday in Arabic, Monday in English (backend weekStartsOn). */
export const weekStartsOn = (lang: Lang): 0 | 1 => (lang === "ar" ? 0 : 1);

const DOW: [en: string, ar: string][] = [
  ["Sun", "الأحد"],
  ["Mon", "الاثنين"],
  ["Tue", "الثلاثاء"],
  ["Wed", "الأربعاء"],
  ["Thu", "الخميس"],
  ["Fri", "الجمعة"],
  ["Sat", "السبت"],
];

export interface PeaksRow {
  /** 0 = Sunday … 6 = Saturday (the server's row). */
  dow: number;
  label: string;
  cells: { hour: number; count: number; intensity: number }[];
}

/** The matrix in the language's week order with 0..1 intensities (0 when every cell is 0). */
export function peaksScale(matrix: number[][], lang: Lang): { rows: PeaksRow[]; max: number; total: number } {
  const start = weekStartsOn(lang);
  let max = 0;
  let total = 0;
  for (const row of matrix) for (const v of row) {
    max = Math.max(max, v);
    total += v;
  }
  const rows: PeaksRow[] = [];
  for (let i = 0; i < 7; i++) {
    const dow = (start + i) % 7;
    const r = matrix[dow] ?? [];
    rows.push({
      dow,
      label: DOW[dow][lang === "ar" ? 1 : 0],
      cells: Array.from({ length: 24 }, (_, hour) => {
        const count = r[hour] ?? 0;
        return { hour, count, intensity: max ? count / max : 0 };
      }),
    });
  }
  return { rows, max, total };
}

// ── labels ──────────────────────────────────────────────────────────────

export const SPEED_BUCKETS: readonly SpeedBucket[] = ["lt_5m", "5_15m", "15_60m", "1_4h", "4_24h", "gt_24h", "not_replied"];

const SPEED_WORDS: Record<SpeedBucket, [en: string, ar: string]> = {
  lt_5m: ["Under 5 min", "أقل من 5 د"],
  "5_15m": ["5–15 min", "5–15 د"],
  "15_60m": ["15–60 min", "15–60 د"],
  "1_4h": ["1–4 h", "1–4 س"],
  "4_24h": ["4–24 h", "4–24 س"],
  gt_24h: ["Over 24 h", "أكثر من 24 س"],
  not_replied: ["Not replied", "بلا رد"],
};

export function speedBucketLabel(bucket: string, lang: Lang): string {
  const w = SPEED_WORDS[bucket as SpeedBucket];
  return w ? w[lang === "ar" ? 1 : 0] : bucket;
}

/** By-number label: "Unassigned number" (null id) and "Removed number" arrive in English. */
export function numberLabel(row: Pick<ByNumberRow, "channelId" | "label">, lang: Lang): string {
  if (row.channelId === null) return L(lang, "Unassigned number", "رقم غير مخصص");
  if (row.label === "Removed number") return L(lang, "Removed number", "رقم محذوف");
  return row.label;
}

/** Team/rep row name: the "Former member", "Unattributed" and "Unassigned" rows have no user id. */
export function memberLabel(row: Pick<TeamRow, "userId" | "name" | "former">, lang: Lang): string {
  if (row.userId !== null) return row.name;
  if (row.former) return L(lang, "Former member", "عضو سابق");
  if (row.name === "Unassigned") return L(lang, "Unassigned", "غير مُسند");
  return L(lang, "Unattributed", "غير منسوب");
}

const SOURCE_WORDS: Record<string, [en: string, ar: string]> = {
  whatsapp: ["WhatsApp", "واتساب"],
  instagram: ["Instagram", "إنستغرام"],
  facebook: ["Facebook", "فيسبوك"],
  messenger: ["Messenger", "ماسنجر"],
  telegram: ["Telegram", "تيليجرام"],
  tiktok: ["TikTok", "تيك توك"],
  webchat: ["Website chat", "دردشة الموقع"],
  email: ["Email", "البريد الإلكتروني"],
  sms: ["SMS", "رسائل SMS"],
  meta_lead_form: ["Meta lead form", "نموذج عملاء ميتا"],
  manual: ["Added by the team", "أضافه الفريق"],
  import: ["Imported", "مستورد"],
  api: ["API", "واجهة API"],
  hjz: ["HJZ", "HJZ"],
  referral: ["Referral", "إحالة"],
  website: ["Website", "الموقع الإلكتروني"],
  walk_in: ["Walk-in", "زيارة مباشرة"],
  chat: ["Chat", "محادثة"],
};

/** A sales source: ads keep their name; channel kinds and contact sources are raw keys to translate. */
export function sourceLabel(row: { kind: string; key: string; label: string }, lang: Lang): string {
  if (row.kind === "ad") return row.label;
  const w = SOURCE_WORDS[row.key.toLowerCase()];
  if (w) return w[lang === "ar" ? 1 : 0];
  if (!row.key) return L(lang, "Unknown source", "مصدر غير معروف");
  // An unknown key: readable, not translated ("google_ads" → "google ads").
  return row.label.replace(/_/g, " ");
}

export const SOURCE_KIND_WORDS: Record<string, [en: string, ar: string]> = {
  ad: ["Ad", "إعلان"],
  channel: ["Channel", "قناة"],
  contact_source: ["Contact source", "مصدر جهة الاتصال"],
};

/** Lost reason: catalog/snapshot labels as given; the null fallback is "No reason" / "بدون سبب". */
export function lostReasonLabel(row: { reasonId: string | null; label: string; labelAr: string }, lang: Lang): string {
  if (!row.label && !row.labelAr) return L(lang, "No reason", "بدون سبب");
  return lang === "ar" ? row.labelAr || row.label : row.label || row.labelAr;
}

/** Stage label of the funnel. */
export const stageLabel = (row: { label: string; labelAr: string }, lang: Lang) => (lang === "ar" ? row.labelAr || row.label : row.label || row.labelAr);

/** The pipeline's name, or a neutral word when the viewer only got `{id}` (no tickets.view). */
export function pipelineName(p: SalesPipelineRef | null | undefined, lang: Lang): string {
  if (!p) return DASH;
  const n = lang === "ar" ? p.nameAr || p.name : p.name || p.nameAr;
  return n || L(lang, "Pipeline", "المسار");
}

/** Share of a part in a whole, as a 0..1 fraction (0 for an empty whole). */
export const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

// ── dates and links ─────────────────────────────────────────────────────

/**
 * The day staff replies started carrying their sender (`Message.sentById`,
 * migration 20261116140000_insights_home). Older replies count as "Unattributed".
 */
export const ATTRIBUTION_SINCE = "2026-11-16";

/** A `YYYY-MM-DD` day as "16 Nov 2026" / "16 نوفمبر 2026" (Gregorian, Latin digits). */
export function formatDay(day: string, lang: Lang): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-u-nu-latn-ca-gregory" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(t));
}

/** A short `YYYY-MM-DD` week label: "3 Nov" / "3 نوفمبر". */
export function formatShortDay(day: string, lang: Lang): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-u-nu-latn-ca-gregory" : "en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(t));
}

/** The Follow-ups screen filtered to a member's team follow-ups (its `fu` hash state). */
export function followUpsHref(userId: string): string {
  return setHashParam("#/followups", "fu", encodeJson({ scope: "team", assigneeId: userId, kind: "", pipelineId: "" }));
}

/** The Ads screen's per-ad view. */
export const adHref = (adId: string) => setHashParam("#/ads", "ad", adId);
