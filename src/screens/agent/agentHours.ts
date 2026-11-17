/**
 * SP-20 frontend mirror of backend/src/agent/agent-hours.ts, for the "The
 * agent is replying now / is off now" line. Same rules: the schedule is local
 * wall time in the workspace timezone; `always` replies; `within` replies
 * inside a window; `outside` outside; an empty or invalid schedule fails open.
 * agentHours.test.ts runs the fixture the backend spec runs.
 */
import type { AgentHoursMode } from "@/lib/types";
import { isConfigured, validateSchedule } from "@/screens/calendar/schedule";
import { parseHHMM, wallClock, workspaceTz } from "@/screens/calendar/bookingTime";

/** True / false, or null when the schedule is empty or invalid. */
export function insideSchedule(schedule: unknown, now: Date, tz: string): boolean | null {
  const v = validateSchedule(schedule);
  if (!v.ok || !isConfigured(v.schedule)) return null;
  const clock = wallClock(now, workspaceTz(tz));
  return (v.schedule[clock.weekday] ?? []).some((w) => {
    const from = parseHHMM(w.from) as number;
    const to = parseHHMM(w.to) as number;
    return clock.minutes >= from && clock.minutes < to;
  });
}

export function agentAvailableAt(settings: { hoursMode: AgentHoursMode | string; schedule: unknown }, now: Date, tz: string): boolean {
  const mode = settings.hoursMode;
  if (mode !== "within" && mode !== "outside") return true;
  const inside = insideSchedule(settings.schedule, now, tz);
  if (inside === null) return true;
  return mode === "within" ? inside : !inside;
}
