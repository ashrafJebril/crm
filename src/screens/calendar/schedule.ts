/**
 * SP-10 weekly schedule: mirror of backend/src/bookings/schedule.ts
 * (validation reasons, fit rules), plus display helpers. Pure.
 *
 *  - Shape: `{mon: [{from: "09:00", to: "17:00"}], …}`, any subset of days.
 *  - ≤ MAX_WINDOWS_PER_DAY windows a day, `HH:MM` 00:00..24:00 (24:00 only as
 *    `to`), `from < to`, not overlapping (touching is fine).
 *  - No window on any day = unconfigured: fits everything, offers no slots.
 */
import type { Lang } from "@/lib/types";
import { MAX_WINDOWS_PER_DAY } from "./bookingConstants";
import { WEEKDAYS, localSpan, parseHHMM, weekdayOf, type Weekday } from "./bookingTime";

export interface ScheduleWindow {
  from: string;
  to: string;
}
export type WeeklySchedule = Partial<Record<Weekday, ScheduleWindow[]>>;

export type FitResult =
  | { kind: "ok" }
  | { kind: "off_day"; day: Weekday }
  | { kind: "outside_hours"; day: Weekday; windows: ScheduleWindow[] };

/** The backend's `bookings.schedule_invalid` reasons (pinned by a test). */
export const SCHEDULE_INVALID_REASONS = [
  "not_object",
  "unknown_day",
  "not_array",
  "too_many_windows",
  "window_invalid",
  "time_invalid",
  "start_at_24",
  "from_not_before_to",
  "overlap",
] as const;
export type ScheduleInvalidReason = (typeof SCHEDULE_INVALID_REASONS)[number];

export interface ScheduleError {
  day: string | null;
  /** The window's position in the input (null for a day-level error). */
  index: number | null;
  reason: ScheduleInvalidReason;
}

export type ValidateResult = { ok: true; schedule: WeeklySchedule } | { ok: false; error: ScheduleError };

const DAY_SET = new Set<string>(WEEKDAYS);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Same rules and the same first error as the backend; returns the canonical schedule when valid. */
export function validateSchedule(json: unknown): ValidateResult {
  const fail = (reason: ScheduleInvalidReason, day: string | null = null, index: number | null = null): ValidateResult => ({
    ok: false,
    error: { day, index, reason },
  });
  if (!isPlainObject(json)) return fail("not_object");
  for (const day of Object.keys(json)) if (!DAY_SET.has(day)) return fail("unknown_day", day);
  const out: WeeklySchedule = {};
  for (const day of WEEKDAYS) {
    const list = json[day];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return fail("not_array", day);
    if (list.length > MAX_WINDOWS_PER_DAY) return fail("too_many_windows", day, MAX_WINDOWS_PER_DAY);
    const parsed: { from: number; to: number; index: number; window: ScheduleWindow }[] = [];
    for (let index = 0; index < list.length; index++) {
      const w = list[index];
      if (!isPlainObject(w)) return fail("window_invalid", day, index);
      const from = parseHHMM(w.from);
      const to = parseHHMM(w.to);
      if (from === null || to === null) return fail("time_invalid", day, index);
      if (from === 1440) return fail("start_at_24", day, index);
      if (from >= to) return fail("from_not_before_to", day, index);
      parsed.push({ from, to, index, window: { from: w.from as string, to: w.to as string } });
    }
    parsed.sort((a, b) => a.from - b.from || a.index - b.index);
    for (let i = 1; i < parsed.length; i++) {
      if (parsed[i].from < parsed[i - 1].to) return fail("overlap", day, parsed[i].index);
    }
    if (parsed.length) out[day] = parsed.map((p) => p.window);
  }
  return { ok: true, schedule: out };
}

export function isConfigured(schedule: WeeklySchedule | null | undefined): boolean {
  if (!schedule) return false;
  return WEEKDAYS.some((d) => (schedule[d]?.length ?? 0) > 0);
}

/** The backend's fit rule (Tkana fitWorkingWindows) on a local span. */
export function scheduleFit(
  schedule: WeeklySchedule | null | undefined,
  span: { dateISO: string; startMin: number; endMin: number },
): FitResult {
  if (!schedule || !isConfigured(schedule)) return { kind: "ok" };
  const day = weekdayOf(span.dateISO);
  const windows = schedule[day] ?? [];
  if (!windows.length) return { kind: "off_day", day };
  const fits =
    span.endMin <= 1440 &&
    span.startMin < span.endMin &&
    windows.some((w) => span.startMin >= (parseHHMM(w.from) as number) && span.endMin <= (parseHHMM(w.to) as number));
  return fits ? { kind: "ok" } : { kind: "outside_hours", day, windows: windows.map((w) => ({ ...w })) };
}

export function scheduleFitAt(schedule: WeeklySchedule | null | undefined, startAt: Date, durationMin: number, tz: string): FitResult {
  return scheduleFit(schedule, localSpan(startAt, durationMin, tz));
}

// ── display ─────────────────────────────────────────────────────────────

/** Week order by language (ruling 11): Saturday first in Arabic, Monday first in English. */
export function weekOrder(lang: Lang): Weekday[] {
  return lang === "ar" ? ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] : [...WEEKDAYS];
}

export const DAY_SHORT: Record<Weekday, [en: string, ar: string]> = {
  mon: ["Mon", "الاثنين"],
  tue: ["Tue", "الثلاثاء"],
  wed: ["Wed", "الأربعاء"],
  thu: ["Thu", "الخميس"],
  fri: ["Fri", "الجمعة"],
  sat: ["Sat", "السبت"],
  sun: ["Sun", "الأحد"],
};

export const dayName = (d: Weekday, lang: Lang) => DAY_SHORT[d][lang === "ar" ? 1 : 0];

const windowsText = (ws: ScheduleWindow[]) => ws.map((w) => `${w.from}–${w.to}`).join(", ");

/**
 * "Sun–Thu 09:00–17:00 · Sat 10:00–14:00" (days with the same hours grouped,
 * consecutive days as a range, wrapping around the week), Latin digits in
 * both languages; "Schedule not set" when unconfigured.
 */
export function scheduleSummary(schedule: WeeklySchedule | null | undefined, lang: Lang): string {
  if (!schedule || !isConfigured(schedule)) return lang === "ar" ? "لم يُحدَّد الجدول" : "Schedule not set";
  const order = weekOrder(lang);
  const key = (d: Weekday) => windowsText(schedule[d] ?? []);
  // Runs of consecutive days with the same (non-empty) hours, circular.
  const runs: { start: number; days: Weekday[] }[] = [];
  const seen = new Set<Weekday>();
  for (let i = 0; i < 7; i++) {
    const d = order[i];
    if (seen.has(d) || !key(d)) continue;
    // Walk back to the run's real start (it may wrap from the end of the week).
    let s = i;
    for (let k = 0; k < 6; k++) {
      const prev = order[(s + 6) % 7];
      if (key(prev) !== key(d) || seen.has(prev)) break;
      s = (s + 6) % 7;
    }
    const days: Weekday[] = [];
    for (let j = s; days.length < 7; j = (j + 1) % 7) {
      const dj = order[j];
      if (key(dj) !== key(d) || seen.has(dj)) break;
      days.push(dj);
      seen.add(dj);
    }
    runs.push({ start: i, days });
  }
  const runText = (days: Weekday[]) =>
    days.length === 1 ? dayName(days[0], lang) : `${dayName(days[0], lang)}–${dayName(days[days.length - 1], lang)}`;
  // Group runs that share hours: "Sun–Tue, Thu 09:00–17:00".
  const groups = new Map<string, string[]>();
  for (const r of runs) {
    const k = key(r.days[0]);
    groups.set(k, [...(groups.get(k) ?? []), runText(r.days)]);
  }
  return [...groups.entries()].map(([hours, ds]) => `${ds.join(lang === "ar" ? "، " : ", ")} ${hours}`).join(" · ");
}
