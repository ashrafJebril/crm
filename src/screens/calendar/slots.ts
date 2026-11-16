/**
 * SP-10 slot picker model (pure): availability slots grouped by part of the
 * day in the workspace timezone, and deduped by start time for "Any staff".
 */
import { hhmm, wallClock } from "./bookingTime";

export interface Slot {
  startAt: string; // ISO with offset
  resourceId: string;
}

export type PartOfDay = "morning" | "afternoon" | "evening";

export const PART_WORDS: Record<PartOfDay, [en: string, ar: string]> = {
  morning: ["Morning", "الصباح"],
  afternoon: ["Afternoon", "بعد الظهر"],
  evening: ["Evening", "المساء"],
};

/** Before 12:00 morning, 12:00–16:59 afternoon, 17:00 on evening (local to `tz`). */
export function partOfDay(minutes: number): PartOfDay {
  if (minutes < 12 * 60) return "morning";
  if (minutes < 17 * 60) return "afternoon";
  return "evening";
}

export interface SlotChoice {
  startAt: string;
  /** "HH:MM" in the workspace zone. */
  time: string;
  /** Every resource free at this start, in the server's order. */
  resourceIds: string[];
}

/** Slots grouped by part of day; one choice per start time, listing the free resources. */
export function groupSlots(slots: Slot[], tz: string): Record<PartOfDay, SlotChoice[]> {
  const out: Record<PartOfDay, SlotChoice[]> = { morning: [], afternoon: [], evening: [] };
  const byStart = new Map<number, SlotChoice>();
  for (const s of slots) {
    const t = new Date(s.startAt).getTime();
    let c = byStart.get(t);
    if (!c) {
      const min = wallClock(new Date(t), tz).minutes;
      c = { startAt: s.startAt, time: hhmm(min), resourceIds: [] };
      byStart.set(t, c);
      out[partOfDay(min)].push(c);
    }
    if (!c.resourceIds.includes(s.resourceId)) c.resourceIds.push(s.resourceId);
  }
  for (const k of Object.keys(out) as PartOfDay[]) out[k].sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  return out;
}
