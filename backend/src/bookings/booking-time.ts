/**
 * SP-10 booking time helpers: wall clock <-> instant in the workspace
 * timezone. Pure; Intl only. Built on SP-04 `activities/buckets.ts`
 * (`validTz`, `DEFAULT_TZ`); DST-correct by re-checking the offset at the
 * guessed instant, like `localMidnight`.
 */
import { DEFAULT_TZ, validTz } from "../activities/buckets";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
/** Monday first; `WEEKDAYS[i]` for ISO weekday i + 1. */
export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const BY_UTC_DAY: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface WallClock {
  /** Local calendar date, `YYYY-MM-DD`. */
  dateISO: string;
  /** Minutes since local midnight, 0..1439. */
  minutes: number;
  weekday: Weekday;
}

/** The workspace's zone (`Workspace.timezone`), `Asia/Riyadh` when missing or invalid. */
export function workspaceTz(tz: string | null | undefined): string {
  return tz ? validTz(tz) : DEFAULT_TZ;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` that names a real calendar date. */
export function isDateISO(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function ymd(dateISO: string): [number, number, number] {
  const m = DATE_RE.exec(dateISO);
  if (!m) throw new Error(`invalid date: ${dateISO}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The weekday of a calendar date (no zone involved). */
export function weekdayOf(dateISO: string): Weekday {
  const [y, m, d] = ymd(dateISO);
  return BY_UTC_DAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** `dateISO` plus `n` calendar days. */
export function addDays(dateISO: string, n: number): string {
  const [y, m, d] = ymd(dateISO);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole calendar days from `a` to `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = ymd(a);
  const [by, bm, bd] = ymd(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

function parts(d: Date, tz: string): Record<string, number> {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(d)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o;
}

/** Offset (ms) of `tz` from UTC at instant `d`. */
function offsetMs(d: Date, tz: string): number {
  const p = parts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** Local wall clock of `instant` in `tz`. */
export function wallClock(instant: Date, tz: string): WallClock {
  const zone = workspaceTz(tz);
  const p = parts(instant, zone);
  const dateISO = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
  return { dateISO, minutes: p.hour * 60 + p.minute, weekday: weekdayOf(dateISO) };
}

/**
 * The instant at which the local wall clock in `tz` reads `dateISO` +
 * `minutes` (0..1440; 1440 is the next local midnight), in every zone east
 * or west of UTC:
 *  - candidates use the offset a day before and a day after the wall time,
 *    and only those whose wall clock reads back as asked are kept;
 *  - both kept (fall-back overlap, the wall time occurs twice): the earlier;
 *  - none kept (spring-forward gap, the wall time never occurs): the
 *    pre-transition offset, which is the instant just after the gap
 *    (New York 02:30 on the spring-forward day → 03:30 EDT).
 */
export function instantOf(dateISO: string, minutes: number, tz: string): Date {
  const zone = workspaceTz(tz);
  const [y, m, d] = ymd(dateISO);
  const wall = Date.UTC(y, m - 1, d) + minutes * 60_000;
  // The wall clock asked for, normalized (1440 → next day 00:00).
  const asked = new Date(wall);
  const want = `${pad(asked.getUTCFullYear(), 4)}-${pad(asked.getUTCMonth() + 1)}-${pad(asked.getUTCDate())}`;
  const wantMin = asked.getUTCHours() * 60 + asked.getUTCMinutes();
  const oBefore = offsetMs(new Date(wall - 86_400_000), zone);
  const oAfter = offsetMs(new Date(wall + 86_400_000), zone);
  const reads = (t: number) => {
    const w = wallClock(new Date(t), zone);
    return w.dateISO === want && w.minutes === wantMin;
  };
  const ok = [...new Set([wall - oBefore, wall - oAfter])].filter(reads).sort((a, b) => a - b);
  return new Date(ok.length ? ok[0] : wall - oBefore);
}

/** [start, end) of a local calendar day as instants. */
export function localDayRange(dateISO: string, tz: string): { start: Date; end: Date } {
  return { start: instantOf(dateISO, 0, tz), end: instantOf(addDays(dateISO, 1), 0, tz) };
}

/** Today's local date in `tz`. */
export function todayISO(now: Date, tz: string): string {
  return wallClock(now, tz).dateISO;
}

/**
 * The local span of a booking: its start date and start/end minutes on that
 * date. `endMin` > 1440 means it ends after the next local midnight (ending
 * exactly at midnight is 1440). Durations are real minutes, so a booking over
 * a spring-forward change has its true local end.
 */
export function localSpan(startAt: Date, durationMin: number, tz: string): { dateISO: string; startMin: number; endMin: number } {
  const start = wallClock(startAt, tz);
  const end = wallClock(new Date(startAt.getTime() + durationMin * 60_000), tz);
  const dayGap = daysBetween(start.dateISO, end.dateISO);
  // On a fall-back day the wall clock repeats an hour, so the wall end can be
  // earlier than start + duration; take the later of the two (conservative).
  const endMin = Math.max(dayGap * 1440 + end.minutes, start.minutes + durationMin);
  return { dateISO: start.dateISO, startMin: start.minutes, endMin };
}

/** `HH:MM` for minutes since midnight (24:00 for 1440). */
export function hhmm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Minutes since midnight for `HH:MM` (00:00..24:00), or null. */
export function parseHHMM(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}
