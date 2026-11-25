/**
 * SP-15 pure metric helpers (Architecture → Metrics). Money is reported per
 * currency and never summed across currencies; Unknown is null, never 0.
 */

/** Rounds to 4 decimal places (the `Decimal(14,4)` scale). */
export function round4(n: number): number {
  return Math.round((n + (n >= 0 ? Number.EPSILON : -Number.EPSILON)) * 10_000) / 10_000;
}

/**
 * Cost per conversation = spend / started. Null when nothing started or the
 * spend is unknown (roadmap acceptance `cost per conversation = spend /
 * started (0 started → null)`).
 */
export function costPerConversation(spend: number | null, started: number): number | null {
  return started > 0 && spend !== null ? round4(spend / started) : null;
}

/** Every day from `from` to `to` (`YYYY-MM-DD`, inclusive). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00.000Z`);
  for (let t = Date.parse(`${from}T00:00:00.000Z`); t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** A `DATE` column value (UTC midnight) as `YYYY-MM-DD`. */
export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → the UTC-midnight Date Prisma stores in a `DATE` column. */
export function dateValue(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
