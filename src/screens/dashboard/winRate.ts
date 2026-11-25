/**
 * The win rate as shown on the dashboard. The source of truth,
 * `GET /tickets/dashboard/summary` (TicketsService.dashboardSummary), already
 * returns a whole percent (0–100), as the Analytics and pipeline headers read
 * it; scaling it again showed 5000%.
 */
export function winRatePercent(summary: { winRate: number } | null | undefined): number {
  const v = Number(summary?.winRate ?? 0);
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v)));
}
