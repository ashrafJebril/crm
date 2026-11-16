/**
 * SP-10 final review I1/I2: the week/day/list grids in the workspace
 * timezone. Days are workspace-local `YYYY-MM-DD` strings from the same
 * `viewDays` the fetch range uses (one source of truth for the week), a
 * booking's day and vertical position come from `wallClock(tz)`, and labels
 * are formatted from the calendar date itself (never the browser zone), with
 * Latin digits. Pure.
 */
import type { Appointment, Lang } from "@/lib/types";
import { hhmm, wallClock } from "./bookingTime";

/** A booking's workspace-local day. */
export const dayOfAppt = (startAt: string, tz: string) => wallClock(new Date(startAt), tz).dateISO;

/** Minutes since local midnight of a booking's start, in the workspace zone. */
export const minutesOfAppt = (startAt: string, tz: string) => wallClock(new Date(startAt), tz).minutes;

/** "HH:MM" of an instant in the workspace zone (Latin digits). */
export const timeOf = (instant: Date | string, tz: string) =>
  hhmm(wallClock(typeof instant === "string" ? new Date(instant) : instant, tz).minutes);

/** Top offset (px) of a booking in a grid starting at `startHour`. */
export function apptTop(startAt: string, tz: string, startHour: number, hourPx: number): number {
  const min = minutesOfAppt(startAt, tz) - startHour * 60;
  return Math.max(0, (min / 60) * hourPx);
}

/** Bookings bucketed by the given days (others dropped), each day sorted by start. */
export function bucketByDay(appts: Appointment[], days: string[], tz: string): Map<string, Appointment[]> {
  const map = new Map<string, Appointment[]>(days.map((d) => [d, []]));
  for (const a of appts) map.get(dayOfAppt(a.startAt, tz))?.push(a);
  for (const list of map.values()) list.sort((x, y) => new Date(x.startAt).getTime() - new Date(y.startAt).getTime());
  return map;
}

/** Bookings grouped by local day (list view), days ascending. */
export function groupByDay(appts: Appointment[], tz: string): { day: string; list: Appointment[] }[] {
  const map = new Map<string, Appointment[]>();
  const sorted = [...appts].sort((x, y) => new Date(x.startAt).getTime() - new Date(y.startAt).getTime());
  for (const a of sorted) {
    const d = dayOfAppt(a.startAt, tz);
    map.set(d, [...(map.get(d) ?? []), a]);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => ({ day, list }));
}

export interface WeekStats {
  todayCount: number;
  weekCount: number;
  noShowPct: number;
}

/** Today's and the week's counts on the same days the grid draws; no-show rate over finished bookings. */
export function weekStats(appts: Appointment[], days: string[], today: string, tz: string): WeekStats {
  const set = new Set(days);
  let todayCount = 0;
  let weekCount = 0;
  let completed = 0;
  let noShow = 0;
  for (const a of appts) {
    const d = dayOfAppt(a.startAt, tz);
    if (d === today) todayCount++;
    if (set.has(d)) weekCount++;
    if (a.status === "completed") completed++;
    if (a.status === "no-show") noShow++;
  }
  return { todayCount, weekCount, noShowPct: Math.round((noShow / (completed + noShow || 1)) * 100) };
}

// ── labels (the calendar date itself, Latin digits) ─────────────────────

const LOCALE = (lang: Lang) => (lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-US");
const utcDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmt = (iso: string, lang: Lang, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(LOCALE(lang), { ...o, timeZone: "UTC" }).format(utcDate(iso)).replace(/[‎‏؜]/g, "");

export const weekdayShort = (iso: string, lang: Lang) => fmt(iso, lang, { weekday: "short" });
export const dayNumber = (iso: string) => String(Number(iso.slice(8, 10)));
export const dayLabel = (iso: string, lang: Lang) => fmt(iso, lang, { weekday: "long", month: "short", day: "numeric" });
export const dateShort = (iso: string, lang: Lang) => fmt(iso, lang, { weekday: "short", month: "short", day: "numeric" });
export const rangeLabel = (a: string, b: string, lang: Lang) =>
  `${fmt(a, lang, { month: "short", day: "numeric" })} – ${fmt(b, lang, { month: "short", day: "numeric" })}`;
