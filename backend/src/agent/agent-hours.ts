/**
 * SP-20 working-hours mode (pure). Reuses SP-10's schedule shape and its
 * DST-safe wall clock: the schedule is read in the workspace timezone, so a
 * window means local wall time on every day, including DST change days (a
 * wall time skipped by spring-forward never occurs; a repeated fall-back hour
 * is inside the window both times).
 *
 *  - `always` → the agent may reply.
 *  - `within` → only while the local time is inside a window of that weekday.
 *  - `outside` → only while it is not.
 *  - The stored schedule is read window by window (review M4): a window that
 *    does not parse (bad time, from >= to, a start at 24:00, a non-array day,
 *    an unknown day) is skipped, the rest still count. With no usable window
 *    at all the schedule fails open (the agent replies), as Tkana does; the
 *    settings save refuses an empty schedule for `within`/`outside`, so this
 *    only happens with hand-edited rows. The frontend mirror reads it the same
 *    way (src/screens/agent/agentHours.ts; shared fixture).
 *  - An unknown timezone falls back to the SP-10 default zone (Asia/Riyadh).
 */
import { parseHHMM, wallClock, WEEKDAYS, workspaceTz, type Weekday } from "../bookings/booking-time";
import type { HoursMode } from "./agent-constants";

export interface HoursSettings {
  hoursMode: HoursMode | string;
  schedule: unknown;
}

/** The usable windows of each weekday, in minutes; bad windows skipped. */
export function usableWindows(schedule: unknown): Partial<Record<Weekday, { from: number; to: number }[]>> {
  const out: Partial<Record<Weekday, { from: number; to: number }[]>> = {};
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return out;
  for (const day of WEEKDAYS) {
    const list = (schedule as Record<string, unknown>)[day];
    if (!Array.isArray(list)) continue;
    const ok: { from: number; to: number }[] = [];
    for (const w of list) {
      if (!w || typeof w !== "object") continue;
      const from = parseHHMM((w as { from?: unknown }).from);
      const to = parseHHMM((w as { to?: unknown }).to);
      if (from === null || to === null || from >= 1440 || from >= to) continue;
      ok.push({ from, to });
    }
    if (ok.length) out[day] = ok;
  }
  return out;
}

/** True when `now` falls inside a usable window in `tz` (local wall time); null when there is none. */
export function insideSchedule(schedule: unknown, now: Date, tz: string): boolean | null {
  const windows = usableWindows(schedule);
  if (!Object.keys(windows).length) return null;
  const clock = wallClock(now, workspaceTz(tz));
  return (windows[clock.weekday] ?? []).some((w) => clock.minutes >= w.from && clock.minutes < w.to);
}

/** Whether the hours mode lets the agent reply at `now`. */
export function agentAvailableAt(settings: HoursSettings, now: Date, tz: string): boolean {
  const mode = settings.hoursMode;
  if (mode !== "within" && mode !== "outside") return true;
  const inside = insideSchedule(settings.schedule, now, tz);
  if (inside === null) return true; // fail open
  return mode === "within" ? inside : !inside;
}
