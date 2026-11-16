/**
 * SP-10 weekly working schedule (Architecture → Schedule; ruling 6). Pure.
 * Frontend mirror: src/screens/calendar/schedule.ts (pinned by a shared
 * fixture test).
 *
 *  - Shape: `{mon: [{from: "09:00", to: "17:00"}], …}`, any subset of days.
 *  - ≤ MAX_WINDOWS_PER_DAY windows a day, `HH:MM` 00:00..24:00 (24:00 only as
 *    `to`), `from < to`, sorted, not overlapping (touching is fine). Overnight
 *    shifts are split across two days. Breaks are gaps between windows.
 *  - A schedule with no window on any day is unconfigured: it fits every
 *    booking (manual bookings are not gated) and offers no slots.
 */
import { MAX_WINDOWS_PER_DAY } from "./booking-constants";
import { bookingError } from "./booking-errors";
import { localSpan, parseHHMM, WEEKDAYS, weekdayOf, type Weekday } from "./booking-time";

export interface ScheduleWindow {
  from: string;
  to: string;
}
export type WeeklySchedule = Partial<Record<Weekday, ScheduleWindow[]>>;

export type FitResult =
  | { kind: "ok" }
  | { kind: "off_day"; day: Weekday }
  | { kind: "outside_hours"; day: Weekday; windows: ScheduleWindow[] };

export type ScheduleInvalidReason =
  | "not_object"
  | "unknown_day"
  | "not_array"
  | "too_many_windows"
  | "window_invalid"
  | "time_invalid"
  | "start_at_24"
  | "from_not_before_to"
  | "overlap";

const DAY_SET = new Set<string>(WEEKDAYS);

function invalid(reason: ScheduleInvalidReason, day: string | null = null, index: number | null = null): never {
  throw bookingError("bookings.schedule_invalid", { day, index, reason });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates user input and returns the canonical schedule: days in Monday
 * order, windows sorted by start, only `{from, to}`, empty days dropped.
 * Anything malformed is 400 `bookings.schedule_invalid {day, index, reason}`.
 */
export function validateSchedule(json: unknown): WeeklySchedule {
  if (!isPlainObject(json)) invalid("not_object");
  for (const day of Object.keys(json)) if (!DAY_SET.has(day)) invalid("unknown_day", day);
  const out: WeeklySchedule = {};
  for (const day of WEEKDAYS) {
    const list = json[day];
    if (list === undefined) continue;
    if (!Array.isArray(list)) invalid("not_array", day);
    if (list.length > MAX_WINDOWS_PER_DAY) invalid("too_many_windows", day, MAX_WINDOWS_PER_DAY);
    const parsed = list.map((w, index) => {
      if (!isPlainObject(w)) invalid("window_invalid", day, index);
      const from = parseHHMM(w.from);
      const to = parseHHMM(w.to);
      if (from === null || to === null) invalid("time_invalid", day, index);
      if (from === 1440) invalid("start_at_24", day, index);
      if (from >= to) invalid("from_not_before_to", day, index);
      return { from, to, index, window: { from: w.from as string, to: w.to as string } };
    });
    parsed.sort((a, b) => a.from - b.from || a.index - b.index);
    // Report the overlapping window by its position in the caller's input
    // (the later-starting one of the pair), so an editor highlights the right row.
    for (let i = 1; i < parsed.length; i++) {
      if (parsed[i].from < parsed[i - 1].to) invalid("overlap", day, parsed[i].index);
    }
    if (parsed.length) out[day] = parsed.map((p) => p.window);
  }
  return out;
}

/**
 * A stored schedule as a WeeklySchedule, never throwing: rows written before
 * validation existed or by hand fall back to unconfigured.
 */
export function readSchedule(json: unknown): WeeklySchedule {
  try {
    return validateSchedule(json);
  } catch {
    return {};
  }
}

/** True when any day has at least one window. */
export function isConfigured(schedule: WeeklySchedule | null | undefined): boolean {
  if (!schedule) return false;
  return WEEKDAYS.some((d) => (schedule[d]?.length ?? 0) > 0);
}

/** The windows of one weekday, in minutes. */
export function windowsOf(schedule: WeeklySchedule, day: Weekday): { from: number; to: number }[] {
  return (schedule[day] ?? []).map((w) => ({ from: parseHHMM(w.from) as number, to: parseHHMM(w.to) as number }));
}

/**
 * Tkana `fitWorkingWindows`: on the date's weekday, the booking
 * [startMin, endMin) must lie wholly inside ONE window (`start >= from &&
 * end <= to`; ending exactly at `to` fits). Unconfigured → ok; no window that
 * day → off_day; crossing local midnight (endMin > 1440) → outside_hours.
 */
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
    windowsOf(schedule, day).some((w) => span.startMin >= w.from && span.endMin <= w.to);
  return fits ? { kind: "ok" } : { kind: "outside_hours", day, windows: windows.map((w) => ({ ...w })) };
}

/** `scheduleFit` for an instant and a duration, in the workspace timezone `tz`. */
export function scheduleFitAt(
  schedule: WeeklySchedule | null | undefined,
  startAt: Date,
  durationMin: number,
  tz: string,
): FitResult {
  return scheduleFit(schedule, localSpan(startAt, durationMin, tz));
}
