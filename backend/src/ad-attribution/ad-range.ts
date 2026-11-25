import { adsError } from "./ad-errors";

/**
 * SP-15: `from`/`to` day ranges (`YYYY-MM-DD`, inclusive) turned into
 * instants in a timezone (ruling 8: the ad account's when connected, else the
 * workspace's). Shared by the per-ad conversation list (Task 1) and the
 * metrics routes (Task 2).
 */

export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 86_400_000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DayRange {
  from: string;
  to: string;
  tz: string;
  /** Inclusive start instant (midnight of `from` in `tz`). */
  start: Date;
  /** Exclusive end instant (midnight after `to` in `tz`). */
  end: Date;
}

/** A valid IANA zone, else "UTC". */
export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Milliseconds `tz` is ahead of UTC at `instant`. */
function offsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

function parseDay(s: string): number | null {
  const m = DAY.exec(s);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t).toISOString().slice(0, 10) === s ? t : null;
}

const dayString = (utcMidnight: number) => new Date(utcMidnight).toISOString().slice(0, 10);

/** Midnight of `day` (`YYYY-MM-DD`) in `tz`, as an instant. */
export function zonedMidnight(day: string, tz: string): Date {
  const t = parseDay(day);
  if (t === null) throw adsError("ads.range_invalid");
  let guess = t - offsetMs(t, tz);
  // A DST change between the guess and the answer: correct once.
  guess = t - offsetMs(guess, tz);
  return new Date(guess);
}

/** Today's date in `tz`. */
export function todayIn(tz: string, now: Date = new Date()): string {
  return dayString(Math.floor((now.getTime() + offsetMs(now.getTime(), tz)) / DAY_MS) * DAY_MS);
}

/** The local day (`YYYY-MM-DD`) of `instant` in `tz`. */
export function dayOf(instant: Date, tz: string): string {
  return todayIn(tz, instant);
}

/**
 * Validates `from`/`to` (both optional) → a DayRange. Missing `to` = today,
 * missing `from` = 29 days before `to`. 400 `ads.range_invalid` for a bad
 * date, `from > to`, or a span over 366 days.
 */
export function resolveDayRange(
  q: { from?: string | null; to?: string | null },
  tzIn: string | null | undefined,
  now: Date = new Date(),
): DayRange {
  const tz = safeTimeZone(tzIn);
  const to = q.to ? String(q.to) : todayIn(tz, now);
  const toT = parseDay(to);
  if (toT === null) throw adsError("ads.range_invalid");
  const from = q.from ? String(q.from) : dayString(toT - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
  const fromT = parseDay(from);
  if (fromT === null || fromT > toT) throw adsError("ads.range_invalid");
  if ((toT - fromT) / DAY_MS + 1 > MAX_RANGE_DAYS) throw adsError("ads.range_invalid");
  return { from, to, tz, start: zonedMidnight(from, tz), end: zonedMidnight(dayString(toT + DAY_MS), tz) };
}
