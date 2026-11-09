import type { Tx } from "@/lib/tx";
import { lastErrorText } from "./campaignErrors";
import type {
  Campaign,
  CampaignFunnel,
  CampaignInsights,
  FollowUpResult,
  ReadTiming,
  RecipientStatus,
} from "@/lib/types";

/**
 * SP-12 campaign report: pure helpers for the detail page (no React), so the
 * numbers, queries and copy are unit-tested.
 */

export const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  "queued",
  "sent",
  "delivered",
  "read",
  "replied",
  "failed",
  "skipped",
];

/** Display order of the outcome chips. */
export const OUTCOME_ORDER: readonly RecipientStatus[] = [
  "delivered",
  "read",
  "replied",
  "sent",
  "failed",
  "skipped",
  "queued",
];

/** A table filter: one outcome, or every row. */
export type Outcome = RecipientStatus | "all";

/** Outcome names as a reader thinks of them: `delivered` is "Not read" yet, `sent` is "Waiting". */
export function statusLabel(status: Outcome, tx: Tx): string {
  switch (status) {
    case "all":
      return tx("All", "الكل");
    case "delivered":
      return tx("Not read", "لم تُقرأ");
    case "read":
      return tx("Read", "قُرئت");
    case "replied":
      return tx("Replied", "ردّ");
    case "sent":
      return tx("Waiting", "بانتظار التسليم");
    case "failed":
      return tx("Failed", "فشلت");
    case "skipped":
      return tx("Skipped", "مُستبعد");
    case "queued":
      return tx("Not sent", "لم تُرسل");
  }
}

export interface OutcomeChip {
  id: Outcome;
  label: string;
  count: number;
}

export function outcomeChips(counts: Record<RecipientStatus, number> | null, total: number, tx: Tx): OutcomeChip[] {
  return [
    { id: "all", label: statusLabel("all", tx), count: total },
    ...OUTCOME_ORDER.map((s) => ({ id: s, label: statusLabel(s, tx), count: counts?.[s] ?? 0 })),
  ];
}

// ── charts ────────────────────────────────────────────────────────────────

export type FunnelKey = keyof CampaignFunnel;
const FUNNEL_KEYS: FunnelKey[] = ["targeted", "sent", "delivered", "read", "replied"];

export interface FunnelStep {
  key: FunnelKey;
  count: number;
  /** Percent of `targeted`, one decimal; null when nobody was targeted. */
  pct: number | null;
}

/** Each step counts every row that reached at least that outcome (the backend's one-outcome-per-row funnel). */
export function funnelSteps(insights: Pick<CampaignInsights, "funnel">): FunnelStep[] {
  const f = insights.funnel;
  return FUNNEL_KEYS.map((key) => ({
    key,
    count: f[key],
    pct: f.targeted > 0 ? Math.round((f[key] / f.targeted) * 1000) / 10 : null,
  }));
}

export function funnelLabel(key: FunnelKey, tx: Tx): string {
  return {
    targeted: tx("Targeted", "المستهدفون"),
    // Fix m2: this step counts sent + failed, so it is "Attempted"; the list page's "Sent" excludes failures.
    sent: tx("Attempted", "تمت محاولة الإرسال"),
    delivered: tx("Delivered", "وصلت"),
    read: tx("Read", "قُرئت"),
    replied: tx("Replied", "ردّوا"),
  }[key];
}

export const formatPct = (p: number | null): string => (p === null ? "—" : `${p}%`);

/** Bar length in percent of the largest value. */
export const barPct = (n: number, max: number): number => (max > 0 ? Math.min(100, (n / max) * 100) : 0);

export type ReadTimingKey = keyof ReadTiming;
const TIMING_KEYS: ReadTimingKey[] = ["withinHour", "oneToSix", "sixToDay", "afterDay"];

export interface TimingShare {
  key: ReadTimingKey;
  count: number;
  pct: number;
}

/**
 * Whole-number shares that sum to exactly 100 (largest remainder, ties to the
 * earlier bucket; ported from Tkana). Null when nothing was read yet.
 */
export function readTimingShares(t: ReadTiming): TimingShare[] | null {
  const counts = TIMING_KEYS.map((k) => Math.max(0, t[k] ?? 0));
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const raw = counts.map((c) => (c * 100) / total);
  const pct = raw.map(Math.floor);
  let spare = 100 - pct.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (spare <= 0) break;
    pct[i]! += 1;
    spare -= 1;
  }
  return TIMING_KEYS.map((key, i) => ({ key, count: counts[i]!, pct: pct[i]! }));
}

export function readTimingLabel(key: ReadTimingKey, tx: Tx): string {
  return {
    withinHour: tx("Within 1 hour", "خلال ساعة"),
    oneToSix: tx("1–6 hours", "1–6 ساعات"),
    sixToDay: tx("6–24 hours", "6–24 ساعة"),
    afterDay: tx("After 24 hours", "بعد 24 ساعة"),
  }[key];
}

export interface ReplyLine {
  text: string;
  count: number;
  typed: boolean;
}

/** Buttons first (largest count first), typed replies last. */
export function replyLines(replies: CampaignInsights["replies"], tx: Tx): ReplyLine[] {
  const buttons = replies
    .filter((r) => r.payload !== null)
    .sort((a, b) => b.count - a.count)
    .map((r) => ({ text: r.label?.trim() || r.payload!, count: r.count, typed: false }));
  const typed = replies
    .filter((r) => r.payload === null)
    .map((r) => ({ text: tx("Typed replies", "ردود مكتوبة"), count: r.count, typed: true }));
  return [...buttons, ...typed];
}

// ── table ─────────────────────────────────────────────────────────────────

export const RECIPIENTS_PAGE = 50;

export function recipientsPath(id: string, outcome: Outcome, cursor: string | null, limit = RECIPIENTS_PAGE): string {
  const q = new URLSearchParams({ limit: String(limit) });
  if (outcome !== "all") q.set("status", outcome);
  if (cursor) q.set("cursor", cursor);
  return `/campaigns/${encodeURIComponent(id)}/recipients?${q.toString().replace(/\+/g, "%20")}`;
}

/** Appends a page, dropping rows already loaded, in order. */
export function mergePages<T extends { id: string }>(prev: readonly T[], next: readonly T[]): T[] {
  const seen = new Set(prev.map((r) => r.id));
  const out = [...prev];
  for (const r of next) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

export type SelectionState = "none" | "some" | "all";

export function selectionState(selected: ReadonlySet<string>, loaded: readonly { id: string }[]): SelectionState {
  if (loaded.length === 0) return "none";
  const n = loaded.filter((r) => selected.has(r.id)).length;
  return n === 0 ? "none" : n === loaded.length ? "all" : "some";
}

/** The "tick all loaded" box: ticks every loaded row, or unticks them when all are ticked. */
export function toggleAllLoaded(selected: ReadonlySet<string>, loaded: readonly { id: string }[]): Set<string> {
  const next = new Set(selected);
  if (selectionState(selected, loaded) === "all") for (const r of loaded) next.delete(r.id);
  else for (const r of loaded) next.add(r.id);
  return next;
}

// ── polling ───────────────────────────────────────────────────────────────

export const INSIGHTS_POLL_MS = 30_000;
const TRACKING_WINDOW_MS = 72 * 3_600_000;

/**
 * Insights poll while the campaign sends, and for 72 h after its effective
 * send time `scheduledAt ?? launchedAt`, the same base as the backend sweep
 * tail and reply attribution (the sweep keeps landing late reads and
 * failures for that long). The hidden tab pause is useFetch's (React
 * Query's refetchIntervalInBackground).
 */
export function insightsPollMs(
  c: Pick<Campaign, "status" | "launchedAt" | "scheduledAt"> | null,
  now: number,
): number | null {
  if (!c) return null;
  if (c.status === "scheduled" || c.status === "running") return INSIGHTS_POLL_MS;
  const base = c.scheduledAt ?? c.launchedAt;
  const sentAt = base ? Date.parse(base) : NaN;
  if (Number.isFinite(sentAt) && now - sentAt < TRACKING_WINDOW_MS) return INSIGHTS_POLL_MS;
  return null;
}

// ── SP-13 background launch ───────────────────────────────────────────────

export const LAUNCH_POLL_MS = 5_000;

export const CAMPAIGN_STATUSES: readonly Campaign["status"][] = [
  "draft",
  "launching",
  "scheduled",
  "running",
  "completed",
  "failed",
  "cancelled",
  "paused",
];

export function campaignStatusLabel(s: Campaign["status"], tx: Tx): string {
  const labels: Record<Campaign["status"], string> = {
    running: tx("Sending", "قيد الإرسال"),
    scheduled: tx("Scheduled", "مجدولة"),
    draft: tx("Draft", "مسودة"),
    completed: tx("Completed", "منتهية"),
    failed: tx("Failed", "فشلت"),
    cancelled: tx("Cancelled", "ملغاة"),
    paused: tx("Paused", "متوقفة"),
    launching: tx("Preparing", "قيد التحضير"),
  };
  return labels[s] ?? s;
}

/** Poll the campaign every 5 s while the background launch runs; stop once it has moved on. */
export const launchPollMs = (c: Pick<Campaign, "status"> | null): number | null =>
  c?.status === "launching" ? LAUNCH_POLL_MS : null;

/** The campaign query's interval: the launch's while launching, else the report's. */
export function campaignPollMs(
  c: Pick<Campaign, "status" | "launchedAt" | "scheduledAt"> | null,
  now: number,
): number | null {
  return launchPollMs(c) ?? insightsPollMs(c, now);
}

export interface LaunchProgressView {
  /** Still launching (shows the spinner and Cancel). */
  active: boolean;
  stage: string;
  lines: string[];
  /** 0..100 when the total is known. */
  pct: number | null;
  /** The stored lastError, worded, when the launch failed. */
  error: string | null;
}

const n = (v: number) => (v ?? 0).toLocaleString("en-US");

export function launchProgressView(
  c: Pick<Campaign, "status" | "launchStage" | "sendTransport" | "lastError" | "launch">,
  tx: Tx,
): LaunchProgressView {
  const active = c.status === "launching";
  const p = c.launch ?? null;
  const stageKey = p?.stage ?? c.launchStage ?? (active ? "planning" : null);
  const stage = !active && c.status === "failed"
    ? tx("Couldn't start", "تعذّر البدء")
    : stageKey === "sending"
      ? tx("Sending", "جارٍ الإرسال")
      : tx("Preparing the recipient list", "جارٍ تجهيز قائمة المستلمين");
  const lines: string[] = [];
  let pct: number | null = null;
  if (active && p) {
    lines.push(tx(`${n(p.planned)} recipients planned`, `${n(p.planned)} مستلم مخطط`));
    if (p.stage === "sending") {
      if (c.sendTransport === "direct") {
        lines.push(tx(`${n(p.directSent)} of ${n(p.planned)} messages sent`, `أُرسلت ${n(p.directSent)} من ${n(p.planned)} رسالة`));
        pct = p.planned > 0 ? Math.min(100, Math.round((p.directSent / p.planned) * 100)) : null;
      } else if (p.partitionsTotal > 0) {
        lines.push(tx(`${n(p.partitionsDone)} of ${n(p.partitionsTotal)} batches sent`, `أُرسلت ${n(p.partitionsDone)} من ${n(p.partitionsTotal)} دفعات`));
        pct = Math.min(100, Math.round((p.partitionsDone / p.partitionsTotal) * 100));
      }
    }
  }
  const error = c.status === "failed" ? lastErrorText(c.lastError, tx) : null;
  return { active, stage, lines, pct, error };
}

// ── export and follow-ups ─────────────────────────────────────────────────

/** Which rows an action takes: the whole campaign, the current outcome, or the ticked rows. */
export type Scope = "all" | "outcome" | "ticked";
export type ExportLang = "en" | "ar";

/** Body for POST /campaigns/:id/export. */
export function exportBody(
  scope: Scope,
  outcome: Outcome,
  ids: readonly string[],
  lang: ExportLang,
): { status?: RecipientStatus; ids?: string[]; lang: ExportLang } {
  if (scope === "ticked") return { ids: [...ids], lang };
  if (scope === "outcome" && outcome !== "all") return { status: outcome, lang };
  return { lang };
}

/** Backend `asciiSlug`, so a fallback filename matches the server's. */
export function asciiSlug(s: string, max = 40): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/**
 * The server's Content-Disposition filename when the browser can read it,
 * else the same pattern built here: `campaign-<slug|id>-<status|all|selected>-<yyyy-mm-dd>.csv` (UTC date).
 */
export function exportFilename(
  serverName: string | null,
  campaign: { id: string; name: string },
  scope: Scope,
  outcome: Outcome,
  now: Date,
): string {
  if (serverName) return serverName;
  const slug = asciiSlug(campaign.name ?? "") || campaign.id.replace(/[^A-Za-z0-9_-]/g, "") || "export";
  const part = scope === "ticked" ? "selected" : scope === "outcome" && outcome !== "all" ? outcome : "all";
  return `campaign-${slug}-${part}-${now.toISOString().slice(0, 10)}.csv`;
}

/** Follow-up target: exactly one of a whole outcome or the ticked ids; null when neither applies. */
export function followUpTarget(
  scope: Exclude<Scope, "all">,
  outcome: Outcome,
  ids: readonly string[],
): { status: RecipientStatus } | { ids: string[] } | null {
  if (scope === "ticked") return ids.length ? { ids: [...ids] } : null;
  return outcome === "all" ? null : { status: outcome };
}

export const GROUP_NAME_MAX = 120;

export function defaultGroupName(campaignName: string, outcome: Outcome, tx: Tx): string {
  const name = outcome === "all" ? campaignName : `${campaignName} · ${statusLabel(outcome, tx)}`;
  return name.trim().slice(0, GROUP_NAME_MAX);
}

/** The result toast: "added · already · left out". */
export function followUpSummary(r: Pick<FollowUpResult, "added" | "already" | "leftOut">, tx: Tx): string {
  const n = (v: number) => (v ?? 0).toLocaleString("en-US");
  return [
    tx(`${n(r.added)} added`, `أُضيف ${n(r.added)}`),
    tx(`${n(r.already)} already there`, `${n(r.already)} موجودون مسبقًا`),
    tx(`${n(r.leftOut)} left out`, `${n(r.leftOut)} مستبعدون`),
  ].join(" · ");
}
