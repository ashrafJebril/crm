import { withRetryAfter, ZernioBudget } from "../../campaigns/sending/zernio-budget";

/** Retries of one health call after a 429 (a live check must answer quickly). */
export const HEALTH_RETRIES = 2;
/** Longest single Retry-After wait for a health call. */
export const HEALTH_MAX_WAIT_MS = 20_000;

/**
 * SP-14 ruling 6: one Zernio number-health call. Before every attempt it
 * takes a token from the shared `campaign` bucket, then one from `health`,
 * so health always counts against the team-wide limit and never outruns its
 * own cap. A 429 pauses the shared `campaign` bucket for its Retry-After
 * (every Zernio caller waits) and the call is retried, up to HEALTH_RETRIES.
 */
export function zernioHealthCall<T>(fn: () => Promise<T>, budget: ZernioBudget = ZernioBudget.shared()): Promise<T> {
  return withRetryAfter(fn, {
    sleep: (ms) => budget.clock.sleep(ms),
    before: async () => {
      await budget.campaign.take();
      await budget.health.take();
    },
    onRateLimit: (ms) => budget.campaign.pause(ms),
    maxRetries: HEALTH_RETRIES,
    maxWaitMs: HEALTH_MAX_WAIT_MS,
  });
}
