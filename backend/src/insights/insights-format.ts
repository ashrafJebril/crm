import { SECONDS_SAVED_PER_MESSAGE, SPEED_BUCKET_KEYS, type SpeedBucket } from "./insights-constants";
import { localWeekStart } from "./insights-range";
import type { ByNumberRow, Peaks, TeamRow, TopicFrictionRow } from "./insights.dto";

/**
 * Presentation rules shared by the service (over SQL rows) and the test
 * oracle (over the fixture world): rounding, null-not-zero, labels and row
 * order. The metric definitions themselves live in `support-metrics.sql.ts`.
 */

export const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Percent with one decimal; null when the denominator is empty. */
export const ratePct = (n: number, d: number): number | null => (d > 0 ? round1((100 * n) / d) : null);

/** A median in whole seconds; null stays null (no samples). */
export const wholeSeconds = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined ? null : Math.round(Number(v));

/** Time saved: customer messages answered first by the AI × 60 s, in hours. */
export const hoursSaved = (customerMessages: number): number =>
  round1((customerMessages * SECONDS_SAVED_PER_MESSAGE) / 3600);

export const UNASSIGNED_NUMBER = "Unassigned number";
export const REMOVED_NUMBER = "Removed number";
export const FORMER_MEMBER = "Former member";
export const UNATTRIBUTED = "Unattributed";

/** Team grouping keys for senders/assignees that are not current members. */
export const FORMER_KEY = "~former";
export const UNATTRIBUTED_KEY = "~unattributed";

export function emptyPeaks(): Peaks {
  return { matrix: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)), byHour: new Array<number>(24).fill(0) };
}

/** Peaks from `(dow, hour, n)` rows. */
export function peaksFrom(rows: { dow: number; hour: number; n: number }[]): Peaks {
  const p = emptyPeaks();
  for (const r of rows) {
    const d = Number(r.dow);
    const h = Number(r.hour);
    if (d < 0 || d > 6 || h < 0 || h > 23) continue;
    p.matrix[d][h] += Number(r.n);
    p.byHour[h] += Number(r.n);
  }
  return p;
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** By-number rows: real numbers by conversations desc then label, then a
 *  removed number, then the unassigned one. */
export function byNumberRows(
  rows: { channelId: string | null; label: string | null; exists: boolean; conversations: number; decided: number; ai: number }[],
): ByNumberRow[] {
  const rank = (r: { channelId: string | null; exists: boolean }) => (r.channelId === null ? 2 : r.exists ? 0 : 1);
  return [...rows]
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(b.conversations) - Number(a.conversations) ||
        byCodePoint(a.label ?? "", b.label ?? "") ||
        byCodePoint(a.channelId ?? "", b.channelId ?? ""),
    )
    .map((r) => ({
      channelId: r.channelId,
      label: r.channelId === null ? UNASSIGNED_NUMBER : r.exists ? (r.label ?? "") : REMOVED_NUMBER,
      conversations: Number(r.conversations),
      aiResolutionRate: ratePct(Number(r.ai), Number(r.decided)),
    }));
}

/** Topic rows: count desc, then topic. */
export function topicRows(rows: { topic: string; count: number; escalated: number; negative: number }[]): TopicFrictionRow[] {
  return [...rows]
    .sort((a, b) => Number(b.count) - Number(a.count) || byCodePoint(a.topic, b.topic))
    .map((r) => ({
      topic: r.topic,
      count: Number(r.count),
      escalatedShare: ratePct(Number(r.escalated), Number(r.count)) ?? 0,
      negativeShare: ratePct(Number(r.negative), Number(r.count)) ?? 0,
    }));
}

export interface TeamTotals {
  assigned: number;
  replies: number;
  resolved: number;
  median: number | null;
}

/**
 * Team rows: every current member (zeros included), ordered by replies,
 * assigned, then name; then one "Former member" row and one "Unattributed"
 * row, each only when it has something to show.
 */
export function teamRows(members: { userId: string; name: string }[], totals: Map<string, TeamTotals>): TeamRow[] {
  const zero: TeamTotals = { assigned: 0, replies: 0, resolved: 0, median: null };
  const row = (userId: string | null, name: string, former: boolean, t: TeamTotals): TeamRow => ({
    userId,
    name,
    former,
    assigned: Number(t.assigned),
    replies: Number(t.replies),
    medianFirstResponseSec: wholeSeconds(t.median),
    resolved: Number(t.resolved),
  });
  const people = members
    .map((m) => row(m.userId, m.name, false, totals.get(m.userId) ?? zero))
    .sort((a, b) => b.replies - a.replies || b.assigned - a.assigned || byCodePoint(a.name, b.name) || byCodePoint(a.userId ?? "", b.userId ?? ""));
  const shows = (t?: TeamTotals) => !!t && (t.assigned > 0 || t.replies > 0 || t.resolved > 0 || t.median !== null);
  const former = totals.get(FORMER_KEY);
  const unattributed = totals.get(UNATTRIBUTED_KEY);
  return [
    ...people,
    ...(shows(former) ? [row(null, FORMER_MEMBER, true, former as TeamTotals)] : []),
    ...(shows(unattributed) ? [row(null, UNATTRIBUTED, false, unattributed as TeamTotals)] : []),
  ];
}

// ── Sales (SP-11 Task 2) ────────────────────────────────────────────────

export const UNASSIGNED_REP = "Unassigned";
export const NO_REASON = "No reason";
export const NO_REASON_AR = "بدون سبب";

/** Every speed bucket in order, zeros included. */
export function distributionRows(rows: { bucket: string; n: number }[]): { bucket: SpeedBucket; count: number }[] {
  const by = new Map(rows.map((r) => [r.bucket, Number(r.n)]));
  return SPEED_BUCKET_KEYS.map((bucket) => ({ bucket, count: by.get(bucket) ?? 0 }));
}

/** Every week of the range (its first local day, `YYYY-MM-DD`), zeros filled. */
export function weeklyRows(
  rows: { week: string; leads: number; won: number }[],
  from: string,
  to: string,
  lang: string | null,
): { weekStart: string; leads: number; won: number }[] {
  const by = new Map(rows.map((r) => [r.week, r]));
  const out: { weekStart: string; leads: number; won: number }[] = [];
  const last = Date.parse(`${localWeekStart(to, lang)}T00:00:00Z`);
  for (let t = Date.parse(`${localWeekStart(from, lang)}T00:00:00Z`); t <= last; t += 7 * 86_400_000) {
    const weekStart = new Date(t).toISOString().slice(0, 10);
    const r = by.get(weekStart);
    out.push({ weekStart, leads: Number(r?.leads ?? 0), won: Number(r?.won ?? 0) });
  }
  return out;
}

export interface SourceRow {
  kind: "ad" | "channel" | "contact_source";
  key: string;
  id?: string;
  label: string;
  leads: number;
  won: number;
}

/** Sources by leads desc, then label, kind and key. Ads carry their id. */
export function sourceRows(rows: { kind: string; key: string; label: string | null; leads: number; won: number }[]): SourceRow[] {
  return rows
    .map((r) => ({
      kind: r.kind as SourceRow["kind"],
      key: r.key,
      ...(r.kind === "ad" ? { id: r.key } : {}),
      label: r.label ?? r.key,
      leads: Number(r.leads),
      won: Number(r.won),
    }))
    .sort(
      (a, b) =>
        b.leads - a.leads || byCodePoint(a.label, b.label) || byCodePoint(a.kind, b.kind) || byCodePoint(a.key, b.key),
    );
}

export interface FunnelRow {
  stageId: string;
  key: string;
  label: string;
  labelAr: string;
  reached: number;
  isWon: boolean;
  isTerminal: boolean;
}

/** Open stages in order, then the won stage(s), then the lost ones. */
export function funnelRows(
  rows: { stageId: string; key: string; label: string; labelAr: string; isWon: boolean; isTerminal: boolean; order: number; reached: number }[],
): FunnelRow[] {
  const rank = (r: { isTerminal: boolean; isWon: boolean }) => (!r.isTerminal ? 0 : r.isWon ? 1 : 2);
  return [...rows]
    .sort((a, b) => rank(a) - rank(b) || Number(a.order) - Number(b.order) || byCodePoint(a.key, b.key))
    .map((r) => ({
      stageId: r.stageId,
      key: r.key,
      label: r.label,
      labelAr: r.labelAr,
      reached: Number(r.reached),
      isWon: !!r.isWon,
      isTerminal: !!r.isTerminal,
    }));
}

export interface LostReasonRow {
  reasonId: string | null;
  label: string;
  labelAr: string;
  count: number;
}

/** Catalog reason, else the snapshot text, else "No reason"; by count desc, label. */
export function lostReasonRows(
  rows: { reasonId: string | null; label: string | null; labelAr: string | null; snapshot: string | null; n: number }[],
): LostReasonRow[] {
  const merged = new Map<string, LostReasonRow>();
  for (const r of rows) {
    const row: LostReasonRow = r.reasonId
      ? { reasonId: r.reasonId, label: r.label ?? "", labelAr: r.labelAr ?? r.label ?? "", count: Number(r.n) }
      : r.snapshot
        ? { reasonId: null, label: r.snapshot, labelAr: r.snapshot, count: Number(r.n) }
        : { reasonId: null, label: NO_REASON, labelAr: NO_REASON_AR, count: Number(r.n) };
    const k = row.reasonId ? `id:${row.reasonId}` : `text:${row.label}`;
    const prev = merged.get(k);
    merged.set(k, prev ? { ...prev, count: prev.count + row.count } : row);
  }
  return [...merged.values()].sort((a, b) => b.count - a.count || byCodePoint(a.label, b.label));
}

export interface RepTotals {
  leads: number;
  won: number;
  lost: number;
  median: number | null;
  done: number;
  overdue: number;
  dueToday: number;
}

export interface RepRow {
  userId: string | null;
  name: string;
  former: boolean;
  leads: number;
  won: number;
  lost: number;
  medianSpeedToReplySec: number | null;
  followUps: { done: number; overdue: number; dueToday: number };
}

/**
 * Reps: every current member (zeros included) by leads, won, then name; then
 * one "Former member" row and one "Unassigned" row, each only when non-zero.
 */
export function repRows(members: { userId: string; name: string }[], totals: Map<string, RepTotals>, unassignedKey: string): RepRow[] {
  const zero: RepTotals = { leads: 0, won: 0, lost: 0, median: null, done: 0, overdue: 0, dueToday: 0 };
  const row = (userId: string | null, name: string, former: boolean, t: RepTotals): RepRow => ({
    userId,
    name,
    former,
    leads: Number(t.leads),
    won: Number(t.won),
    lost: Number(t.lost),
    medianSpeedToReplySec: wholeSeconds(t.median),
    followUps: { done: Number(t.done), overdue: Number(t.overdue), dueToday: Number(t.dueToday) },
  });
  const people = members
    .map((m) => row(m.userId, m.name, false, totals.get(m.userId) ?? zero))
    .sort((a, b) => b.leads - a.leads || b.won - a.won || byCodePoint(a.name, b.name) || byCodePoint(a.userId ?? "", b.userId ?? ""));
  const shows = (t?: RepTotals) =>
    !!t && (t.leads > 0 || t.won > 0 || t.lost > 0 || t.median !== null || t.done > 0 || t.overdue > 0 || t.dueToday > 0);
  const former = totals.get(FORMER_KEY);
  const unassigned = totals.get(unassignedKey);
  return [
    ...people,
    ...(shows(former) ? [row(null, FORMER_MEMBER, true, former as RepTotals)] : []),
    ...(shows(unassigned) ? [row(null, UNASSIGNED_REP, false, unassigned as RepTotals)] : []),
  ];
}
