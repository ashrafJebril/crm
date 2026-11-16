import { SECONDS_SAVED_PER_MESSAGE } from "./insights-constants";
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
