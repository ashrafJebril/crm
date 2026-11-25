const DAY_MS = 86_400_000;

/**
 * A card is stale when the pipeline has a stale threshold and the ticket has
 * sat in its current stage for strictly more than that many days. Closed
 * (won/lost) stages never go stale.
 */
export function isStaleTicket(
  enteredStageAt: string,
  staleDays: number | null | undefined,
  now: number = Date.now(),
  stageIsTerminal = false,
): boolean {
  if (!staleDays || staleDays <= 0 || stageIsTerminal) return false;
  const t = Date.parse(enteredStageAt);
  if (Number.isNaN(t)) return false;
  return now - t > staleDays * DAY_MS;
}

export function daysInStage(enteredStageAt: string, now: number = Date.now()): number {
  const t = Date.parse(enteredStageAt);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / DAY_MS));
}
