/** Stable code the backend returns (403) for a payment-locked workspace. */
export const PAYMENT_OVERDUE = "PAYMENT_OVERDUE";

/** The Kewy billing page, from VITE_KEWY_BILLING_URL. Undefined when unset or not an http(s) URL. */
export function billingLink(
  raw: string | undefined = import.meta.env.VITE_KEWY_BILLING_URL as string | undefined,
): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

// Set before React mounts (e.g. a refused embed SSO exchange) so AuthProvider
// starts on the lock screen.
let bootOverdue = false;
export const markBootPaymentOverdue = (): void => { bootOverdue = true; };
export const bootPaymentOverdue = (): boolean => bootOverdue;
