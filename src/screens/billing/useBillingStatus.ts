import { useFetch } from "@/api/useFetch";
import type { BillingStatus } from "@/lib/types";

/** `GET /billing/status` (every member; reduced without billing.view), polled every 60 s. */
export function useBillingStatus() {
  return useFetch<BillingStatus>("/billing/status", { pollMs: 60_000 });
}
