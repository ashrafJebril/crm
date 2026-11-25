/**
 * SP-20 frontend mirror of backend/src/agent/agent-hours.ts, for the "The
 * agent is replying now / is off now" line. Same rules: the schedule is local
 * wall time in the workspace timezone; `always` replies; `within` replies
 * inside a window; `outside` outside. The schedule is read window by window
 * as the backend does: a window that does not parse is skipped and the rest
 * still count; with no usable window it fails open. agentHours.test.ts runs
 * the fixture the backend spec runs.
 */
import type { AgentHoursMode } from "@/lib/types";
import { parseHHMM, wallClock, WEEKDAYS, workspaceTz, type Weekday } from "@/screens/calendar/bookingTime";

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

/** True / false, or null when no window is usable. */
export function insideSchedule(schedule: unknown, now: Date, tz: string): boolean | null {
  const windows = usableWindows(schedule);
  if (!Object.keys(windows).length) return null;
  const clock = wallClock(now, workspaceTz(tz));
  return (windows[clock.weekday] ?? []).some((w) => clock.minutes >= w.from && clock.minutes < w.to);
}

export function agentAvailableAt(settings: { hoursMode: AgentHoursMode | string; schedule: unknown }, now: Date, tz: string): boolean {
  const mode = settings.hoursMode;
  if (mode !== "within" && mode !== "outside") return true;
  const inside = insideSchedule(settings.schedule, now, tz);
  if (inside === null) return true;
  return mode === "within" ? inside : !inside;
}
