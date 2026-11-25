/**
 * SP-10 agenda model (pure): booked minutes per workspace-local day and per
 * staff, counting pending, confirmed and completed bookings (cancelled and
 * no-show excluded), with the conflict count.
 */
import type { Appointment, Lang } from "@/lib/types";
import { wallClock } from "./bookingTime";

export const AGENDA_STATUSES = ["pending", "confirmed", "completed"] as const;

export interface AgendaStaffLine {
  /** resourceId, else `staff:<userId>`, else "none". */
  key: string;
  resourceId: string | null;
  staffId: string | null;
  minutes: number;
  count: number;
}

export interface AgendaDay {
  date: string;
  minutes: number;
  count: number;
  conflicts: number;
  byResource: AgendaStaffLine[];
  items: Appointment[];
}

export function agendaDays(items: Appointment[], tz: string, days?: string[]): AgendaDay[] {
  const byDate = new Map<string, AgendaDay>();
  for (const d of days ?? []) byDate.set(d, { date: d, minutes: 0, count: 0, conflicts: 0, byResource: [], items: [] });
  for (const a of items) {
    if (!(AGENDA_STATUSES as readonly string[]).includes(a.status)) continue;
    // A booking belongs to the local day it starts on (workspace zone).
    const date = wallClock(new Date(a.startAt), tz).dateISO;
    if (days && !byDate.has(date)) continue;
    const day = byDate.get(date) ?? { date, minutes: 0, count: 0, conflicts: 0, byResource: [], items: [] };
    day.minutes += a.durationMin;
    day.count += 1;
    if (a.conflict) day.conflicts += 1;
    day.items.push(a);
    const key = a.resourceId ?? (a.staffId ? `staff:${a.staffId}` : "none");
    let line = day.byResource.find((l) => l.key === key);
    if (!line) {
      line = { key, resourceId: a.resourceId ?? null, staffId: a.staffId ?? null, minutes: 0, count: 0 };
      day.byResource.push(line);
    }
    line.minutes += a.durationMin;
    line.count += 1;
    byDate.set(date, day);
  }
  const out = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of out) {
    d.items.sort((a, b) => a.startAt.localeCompare(b.startAt));
    d.byResource.sort((a, b) => b.minutes - a.minutes || a.key.localeCompare(b.key));
  }
  return out;
}

/** "3 h 15 min booked" / "3 س 15 د محجوزة" (Latin digits in both languages). */
export function bookedText(minutes: number, lang: Lang): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (lang === "ar") {
    const parts = [h ? `${h} س` : "", m || !h ? `${m} د` : ""].filter(Boolean).join(" ");
    return `${parts} محجوزة`;
  }
  const parts = [h ? `${h} h` : "", m || !h ? `${m} min` : ""].filter(Boolean).join(" ");
  return `${parts} booked`;
}
