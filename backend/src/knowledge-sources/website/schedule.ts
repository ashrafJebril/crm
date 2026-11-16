/**
 * SP-21 website schedules. Pure. `daily` and `weekly` add 1 and 7 days;
 * `monthly` moves to the same day of the next month, clamped to that month's
 * last day (Jan 31 → Feb 28/29); `manual` never schedules (null).
 */
export type ScheduleKind = "daily" | "weekly" | "monthly" | "manual";

export function nextRunAt(schedule: ScheduleKind | null | undefined, from: Date): Date | null {
  const t = new Date(from.getTime());
  switch (schedule) {
    case "daily":
      return new Date(t.getTime() + 86_400_000);
    case "weekly":
      return new Date(t.getTime() + 7 * 86_400_000);
    case "monthly": {
      const y = t.getUTCFullYear();
      const m = t.getUTCMonth() + 1;
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      return new Date(
        Date.UTC(y, m, Math.min(t.getUTCDate(), last), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCMilliseconds()),
      );
    }
    default:
      return null;
  }
}
