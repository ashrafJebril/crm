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
 *  - An empty or unreadable stored schedule fails open (the agent replies), as
 *    Tkana does; the settings save refuses an empty schedule for
 *    `within`/`outside`, so this only happens with hand-edited rows.
 *  - An unknown timezone falls back to the SP-10 default zone (Asia/Riyadh).
 */
import { wallClock, workspaceTz } from "../bookings/booking-time";
import { isConfigured, readSchedule, windowsOf } from "../bookings/schedule";
import type { HoursMode } from "./agent-constants";

export interface HoursSettings {
  hoursMode: HoursMode | string;
  schedule: unknown;
}

/** True when `now` falls inside a window of the schedule in `tz` (local wall time). */
export function insideSchedule(schedule: unknown, now: Date, tz: string): boolean | null {
  const s = readSchedule(schedule);
  if (!isConfigured(s)) return null;
  const clock = wallClock(now, workspaceTz(tz));
  return windowsOf(s, clock.weekday).some((w) => clock.minutes >= w.from && clock.minutes < w.to);
}

/** Whether the hours mode lets the agent reply at `now`. */
export function agentAvailableAt(settings: HoursSettings, now: Date, tz: string): boolean {
  const mode = settings.hoursMode;
  if (mode !== "within" && mode !== "outside") return true;
  const inside = insideSchedule(settings.schedule, now, tz);
  if (inside === null) return true; // fail open
  return mode === "within" ? inside : !inside;
}
