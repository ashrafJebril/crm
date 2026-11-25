import {
  RETRY_AFTER_DEFAULT_MS,
  RETRY_AFTER_MAX_MS,
  ZernioBudget,
} from "../../campaigns/sending/zernio-budget";
import { ZernioRateLimitError } from "../../integrations/zernio.client";

/** Retries of one health call after a 429 (a live check must answer quickly). */
export const HEALTH_RETRIES = 2;
/** Longest Retry-After a health call waits out; a longer one is not retried. */
export const HEALTH_MAX_WAIT_MS = 20_000;

/**
 * SP-14 ruling 6: one Zernio number-health call.
 *  - Before every attempt it takes a `health` token, then a shared `campaign`
 *    token (fix round 1, M1: health is throttled by its own bucket before it
 *    reserves a shared slot, so a burst of checks never queues ahead of a
 *    launch).
 *  - A 429 pauses the shared `campaign` bucket for Zernio's full Retry-After
 *    (default 5 s, at most RETRY_AFTER_MAX_MS = 60 s, as `budgeted()` does),
 *    so every Zernio caller waits out the team-wide limit (fix round 1, I1).
 *  - The call is retried after that wait only when it is at most
 *    HEALTH_MAX_WAIT_MS (20 s), up to HEALTH_RETRIES times; otherwise the 429
 *    is rethrown and the caller marks its fields `check_failed`.
 */
export async function zernioHealthCall<T>(fn: () => Promise<T>, budget: ZernioBudget = ZernioBudget.shared()): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await budget.health.take();
    await budget.campaign.take();
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ZernioRateLimitError)) throw e;
      const wait = Math.min(e.retryAfterMs ?? RETRY_AFTER_DEFAULT_MS, RETRY_AFTER_MAX_MS);
      budget.campaign.pause(wait);
      if (wait > HEALTH_MAX_WAIT_MS || attempt >= HEALTH_RETRIES) throw e;
      await budget.clock.sleep(wait);
    }
  }
}
