/**
 * SP-10 time helpers in the workspace timezone: mirror of
 * backend/src/bookings/booking-time.ts (Intl only). The UI shows every time
 * in the workspace zone, never the browser's.
 */
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const BY_UTC_DAY: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export const DEFAULT_TZ = "Asia/Riyadh";

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/** The workspace zone, `Asia/Riyadh` when missing or invalid. */
export function workspaceTz(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  if (FORMATTERS.has(tz)) return tz;
  try {
    formatter(tz);
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function ymd(dateISO: string): [number, number, number] {
  const m = DATE_RE.exec(dateISO);
  if (!m) throw new Error(`invalid date: ${dateISO}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function weekdayOf(dateISO: string): Weekday {
  const [y, m, d] = ymd(dateISO);
  return BY_UTC_DAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function addDays(dateISO: string, n: number): string {
  const [y, m, d] = ymd(dateISO);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = ymd(a);
  const [by, bm, bd] = ymd(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

function parts(d: Date, tz: string): Record<string, number> {
  const o: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(d)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o;
}

function offsetMs(d: Date, tz: string): number {
  const p = parts(d, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000;
}

export interface WallClock {
  dateISO: string;
  minutes: number;
  weekday: Weekday;
}

export function wallClock(instant: Date, tz: string): WallClock {
  const zone = workspaceTz(tz);
  const p = parts(instant, zone);
  const dateISO = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
  return { dateISO, minutes: p.hour * 60 + p.minute, weekday: weekdayOf(dateISO) };
}

/** The instant the wall clock in `tz` reads `dateISO` + `minutes` (a gap time resolves after the gap). */
export function instantOf(dateISO: string, minutes: number, tz: string): Date {
  const zone = workspaceTz(tz);
  const [y, m, d] = ymd(dateISO);
  const wall = Date.UTC(y, m - 1, d) + minutes * 60_000;
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

/** The local span of a booking (endMin > 1440 when it crosses local midnight). */
export function localSpan(startAt: Date, durationMin: number, tz: string): { dateISO: string; startMin: number; endMin: number } {
  const start = wallClock(startAt, tz);
  const end = wallClock(new Date(startAt.getTime() + durationMin * 60_000), tz);
  const endMin = Math.max(daysBetween(start.dateISO, end.dateISO) * 1440 + end.minutes, start.minutes + durationMin);
  return { dateISO: start.dateISO, startMin: start.minutes, endMin };
}

export function hhmm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Minutes for `HH:MM` 00:00..24:00, else null. */
export function parseHHMM(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/** `HH:MM` of an instant in the workspace zone (Latin digits). */
export function timeInTz(instant: Date | string, tz: string): string {
  return hhmm(wallClock(typeof instant === "string" ? new Date(instant) : instant, tz).minutes);
}
