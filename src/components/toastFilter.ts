import { isPlanRequiredError, recentlySignedOut } from "@/api/client";

/**
 * Whether an error toast should show. Two cases stay quiet:
 * - right after a forced sign-out (SP-26 M5: requests cut off by it);
 * - the one 402 PLAN_REQUIRED the global "not in your plan" notice already
 *   explained: identified by the error passed as `cause` (or by its raw key
 *   when a screen toasts the bare message). Nothing time-based: any other
 *   error still shows.
 */
export function shouldShowToast(message: string, kind: string, cause?: unknown): boolean {
  if (kind !== "error") return true;
  if (recentlySignedOut()) return false;
  if (isPlanRequiredError(cause)) return false;
  if (message.trim() === "billing.plan_required") return false;
  return true;
}
