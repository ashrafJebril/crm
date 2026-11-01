export const PAYMENT_GRACE_DAYS = 2;
const DAY_MS = 86_400_000;

export type BillingState = "ok" | "due" | "ended";
export const BILLING_STATES: readonly BillingState[] = ["ok", "due", "ended"];

/** Locked once the payment clock is at least PAYMENT_GRACE_DAYS old. */
export function isPaymentLocked(paymentDueSince: Date | null, now: Date): boolean {
  if (!paymentDueSince) return false;
  return now.getTime() - paymentDueSince.getTime() >= PAYMENT_GRACE_DAYS * DAY_MS;
}

/**
 * Next value of Workspace.paymentDueSince. `due` keeps an existing clock;
 * `ended` backdates the clock by the grace period (unless already older) so
 * the workspace locks at once; `ok` clears. Never involves suspendedAt.
 */
export function applyBillingState(
  current: Date | null,
  state: BillingState,
  now: Date,
): Date | null {
  switch (state) {
    case "ok":
      return null;
    case "due":
      return current ?? now;
    case "ended": {
      const backdated = new Date(now.getTime() - PAYMENT_GRACE_DAYS * DAY_MS);
      return current && current.getTime() <= backdated.getTime() ? current : backdated;
    }
  }
}
