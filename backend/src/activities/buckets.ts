/** Follow-up buckets in the workspace timezone. Pure; uses Intl only. */
export type Bucket = "overdue" | "today" | "upcoming";

function validTz(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Local wall-clock parts of `d` in `tz`. */
function parts(d: Date, tz: string) {
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

/** The UTC instant at which local midnight of y-m-d (month 0-based) occurs. */
function localMidnight(y: number, m: number, d: number, tz: string): Date {
  const wall = Date.UTC(y, m, d);
  let guess = wall - offsetMs(new Date(wall), tz);
  guess = wall - offsetMs(new Date(guess), tz);
  return new Date(guess);
}

/** [start, end) of the local calendar day containing `now`, as UTC instants. */
export function localDayBounds(now: Date, tz: string): { start: Date; end: Date } {
  const zone = validTz(tz);
  const p = parts(now, zone);
  return {
    start: localMidnight(p.year, p.month - 1, p.day, zone),
    end: localMidnight(p.year, p.month - 1, p.day + 1, zone),
  };
}

/** overdue: strictly before now; today: now..end of local day; else upcoming. */
export function bucketOf(dueAt: Date, now: Date, tz: string): Bucket {
  if (dueAt.getTime() < now.getTime()) return "overdue";
  return dueAt.getTime() < localDayBounds(now, tz).end.getTime() ? "today" : "upcoming";
}
