/**
 * SP-10 slot generation (Architecture → Availability; ruling 7). Pure.
 *
 * Per resource, for each window of the date's weekday (workspace timezone),
 * starts run from `from` in SLOT_STEP_MIN steps while the booking still fits
 * the window. Starts before `now` are dropped (no lead time), as are starts
 * overlapping a busy interval (`a.start < b.end && a.end > b.start`; back to
 * back is fine; no buffers). An unconfigured schedule offers no slots and is
 * reported in `unconfigured`.
 */
import { SLOT_STEP_MIN } from "./booking-constants";
import { instantOf, localSpan, weekdayOf } from "./booking-time";
import { isConfigured, readSchedule, scheduleFit, windowsOf } from "./schedule";

export const MAX_SLOTS = 200;

export interface Interval {
  start: number; // epoch ms
  end: number;
}

export interface SlotResource {
  id: string;
  schedule: unknown;
  busy: Interval[];
}

export interface Slot {
  startAt: Date;
  resourceId: string;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && a.end > b.start;
}

export function generateSlots(input: {
  dateISO: string;
  tz: string;
  durationMin: number;
  now: Date;
  resources: SlotResource[];
}): { slots: Slot[]; unconfigured: string[] } {
  const { dateISO, tz, durationMin, now } = input;
  const day = weekdayOf(dateISO);
  const slots: Slot[] = [];
  const unconfigured: string[] = [];
  for (const r of input.resources) {
    const schedule = readSchedule(r.schedule);
    if (!isConfigured(schedule)) {
      unconfigured.push(r.id);
      continue;
    }
    for (const w of windowsOf(schedule, day)) {
      for (let m = w.from; m + durationMin <= w.to; m += SLOT_STEP_MIN) {
        const startAt = instantOf(dateISO, m, tz);
        const start = startAt.getTime();
        if (start < now.getTime()) continue;
        // On a DST day the wall clock and real minutes differ: re-check the
        // real span against the schedule (a start in a gap may not exist).
        const span = localSpan(startAt, durationMin, tz);
        if (span.dateISO !== dateISO || scheduleFit(schedule, span).kind !== "ok") continue;
        const slot = { start, end: start + durationMin * 60_000 };
        if (r.busy.some((b) => overlaps(slot, b))) continue;
        slots.push({ startAt, resourceId: r.id });
      }
    }
  }
  slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.resourceId.localeCompare(b.resourceId));
  // Dedupe a start that two windows produced for the same resource.
  const seen = new Set<string>();
  const out = slots.filter((s) => {
    const k = `${s.resourceId}@${s.startAt.getTime()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { slots: out.slice(0, MAX_SLOTS), unconfigured };
}
