/**
 * SP-11 Analytics URL state:
 * `#/analytics?tab=overview|support|sales&view=team&range=7|30|90|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&channel=<id>&pipeline=<id>`.
 * Defaults stay out of the URL (an old `#/analytics` opens Overview, last 30
 * days). Days are workspace-local. Pure.
 */
import { setHashParam, splitHash } from "@/lib/hashState";

export const INSIGHTS_TABS = ["overview", "support", "sales"] as const;
export type InsightsTab = (typeof INSIGHTS_TABS)[number];
export const RANGE_PRESETS = ["7", "30", "90", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
/** The backend's MAX_RANGE_DAYS. */
export const MAX_RANGE_DAYS = 366;

export interface InsightsParams {
  tab: InsightsTab;
  /** Support's sub-view: the overview or the team table. */
  team: boolean;
  range: RangePreset;
  /** Custom range only (inclusive local days). */
  from: string | null;
  to: string | null;
  channel: string | null;
  pipeline: string | null;
}

export const DEFAULT_INSIGHTS_PARAMS: InsightsParams = {
  tab: "overview",
  team: false,
  range: "30",
  from: null,
  to: null,
  channel: null,
  pipeline: null,
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isDay(s: string | null | undefined): s is string {
  if (!s || !DAY.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function parseInsightsParams(hash: string): InsightsParams {
  const p = splitHash(hash).params;
  const tab = p.get("tab");
  const range = p.get("range");
  const from = p.get("from");
  const to = p.get("to");
  const channel = p.get("channel");
  const pipeline = p.get("pipeline");
  const custom = range === "custom" && isDay(from) && isDay(to) && from <= to;
  return {
    tab: (INSIGHTS_TABS as readonly string[]).includes(tab ?? "") ? (tab as InsightsTab) : "overview",
    team: p.get("view") === "team",
    range: custom ? "custom" : (RANGE_PRESETS as readonly string[]).includes(range ?? "") && range !== "custom" ? (range as RangePreset) : "30",
    from: custom ? from : null,
    to: custom ? to : null,
    channel: channel && ID.test(channel) ? channel : null,
    pipeline: pipeline && ID.test(pipeline) ? pipeline : null,
  };
}

/** The hash with `patch` applied; defaults dropped; other params (`record`, …) kept. */
export function withInsightsParams(hash: string, patch: Partial<InsightsParams>): string {
  const next = { ...parseInsightsParams(hash), ...patch };
  let h = hash;
  const set = (k: string, v: string | null) => (h = setHashParam(h, k, v));
  set("tab", next.tab === "overview" ? null : next.tab);
  set("view", next.team ? "team" : null);
  const custom = next.range === "custom" && isDay(next.from) && isDay(next.to);
  set("range", next.range === "30" || (next.range === "custom" && !custom) ? null : next.range);
  set("from", custom ? next.from : null);
  set("to", custom ? next.to : null);
  set("channel", next.channel);
  set("pipeline", next.pipeline);
  return h;
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The request's `from`/`to` (inclusive local days): a preset ends today. */
export function rangeDays(p: InsightsParams, today: string): { from: string; to: string } {
  if (p.range === "custom" && p.from && p.to) return { from: p.from, to: p.to };
  const n = p.range === "custom" ? 30 : Number(p.range);
  return { from: addDays(today, -(n - 1)), to: today };
}

/** `GET /insights/<tab>?from&to&channelId|pipelineId`. */
export function insightsPath(kind: "support" | "sales", p: InsightsParams, today: string): string {
  const { from, to } = rangeDays(p, today);
  const q = new URLSearchParams({ from, to });
  if (kind === "support" && p.channel) q.set("channelId", p.channel);
  if (kind === "sales" && p.pipeline) q.set("pipelineId", p.pipeline);
  return `/insights/${kind}?${q.toString()}`;
}

/** A custom range the server accepts (≤ 366 days, from ≤ to). */
export function customRangeOk(from: string, to: string): boolean {
  if (!isDay(from) || !isDay(to) || from > to) return false;
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1 <= MAX_RANGE_DAYS;
}
