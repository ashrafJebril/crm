import { Prisma } from "@prisma/client";
import { localMidnight, validTz } from "../activities/buckets";
import { DEFAULT_RANGE_DAYS, MAX_RANGE_DAYS } from "./insights-constants";
import { insightsError } from "./insights-errors";

/**
 * SP-11 report range: `from`/`to` are `YYYY-MM-DD`, inclusive, in the
 * workspace's timezone (SP-04 `validTz`: an invalid zone reads as
 * Asia/Riyadh). One `now` is taken per request and passed in, so every
 * section agrees about "today" (Tkana's one-anchor rule).
 */
export interface InsightsRange {
  /** First local day, inclusive. */
  from: string;
  /** Last local day, inclusive. */
  to: string;
  tz: string;
  /** Local midnight that starts `from`, as a UTC instant (inclusive). */
  fromUtc: Date;
  /** Local midnight after `to`, as a UTC instant (exclusive). */
  toUtcExclusive: Date;
  /** Number of local days in the range (1–366). */
  days: number;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → UTC midnight of that calendar date, or null when malformed
 *  or not a real date (2026-02-30). */
function parseDay(s: string): number | null {
  const m = DAY.exec(s);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t).toISOString().slice(0, 10) === s ? t : null;
}

const dayString = (utcMidnight: number) => new Date(utcMidnight).toISOString().slice(0, 10);

/** The local calendar date (`YYYY-MM-DD`) of `instant` in `tz`. */
export function localDate(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: validTz(tz),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Local midnight starting `day` in `tz`, as a UTC instant. */
export function localDayStart(day: string, tz: string): Date {
  const t = parseDay(day);
  if (t === null) throw insightsError("insights.range_invalid");
  const d = new Date(t);
  return localMidnight(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), validTz(tz));
}

function asDayParam(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw insightsError("insights.range_invalid");
  return v;
}

/**
 * `from`/`to` (both optional) → an InsightsRange. Missing `to` = today
 * (local), missing `from` = 29 days before `to` (the last 30 local days).
 * 400 `insights.range_invalid` for a malformed or impossible date, a
 * non-string value, `from > to`, or a span over 366 days.
 */
export function parseRange(from: unknown, to: unknown, tzIn: string | null | undefined, now: Date): InsightsRange {
  const tz = validTz(tzIn ?? "");
  const toStr = asDayParam(to) ?? localDate(now, tz);
  const toT = parseDay(toStr);
  if (toT === null) throw insightsError("insights.range_invalid");
  const fromStr = asDayParam(from) ?? dayString(toT - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
  const fromT = parseDay(fromStr);
  if (fromT === null || fromT > toT) throw insightsError("insights.range_invalid");
  const days = Math.round((toT - fromT) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) throw insightsError("insights.range_invalid");
  return {
    from: fromStr,
    to: toStr,
    tz,
    fromUtc: localDayStart(fromStr, tz),
    toUtcExclusive: localDayStart(dayString(toT + DAY_MS), tz),
    days,
  };
}

// ── Workspace-local buckets in SQL ─────────────────────────────────────────

/** `col` (a `timestamp(3)` holding UTC, as Prisma stores it) as local wall
 *  time in `tz`: `(col AT TIME ZONE 'UTC') AT TIME ZONE tz`. */
export function localTimeSql(col: Prisma.Sql, tz: string): Prisma.Sql {
  return Prisma.sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE ${validTz(tz)})`;
}

/** Ruling 10: weeks start on Sunday for Arabic workspaces, Monday otherwise.
 *  0 = Sunday … 6 = Saturday (JS `getUTCDay`, Postgres `EXTRACT(DOW)`). */
export function weekStartsOn(lang: string | null | undefined): 0 | 1 {
  return lang === "ar" ? 0 : 1;
}

/** The first local day (`YYYY-MM-DD`) of the week containing local day `day`. */
export function localWeekStart(day: string, lang: string | null | undefined): string {
  const t = parseDay(day);
  if (t === null) throw insightsError("insights.range_invalid");
  const dow = new Date(t).getUTCDay();
  const back = (dow - weekStartsOn(lang) + 7) % 7;
  return dayString(t - back * DAY_MS);
}

/** SQL twin of `localWeekStart` for an instant column: the local date the
 *  week starts on (`date_trunc('week')` is Monday; Sunday weeks shift it by
 *  one day). */
export function localWeekStartSql(col: Prisma.Sql, tz: string, lang: string | null | undefined): Prisma.Sql {
  const local = localTimeSql(col, tz);
  return weekStartsOn(lang) === 0
    ? Prisma.sql`(date_trunc('week', ${local} + interval '1 day') - interval '1 day')::date`
    : Prisma.sql`date_trunc('week', ${local})::date`;
}
