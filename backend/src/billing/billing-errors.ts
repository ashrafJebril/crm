import { BadRequestException, HttpException } from "@nestjs/common";
import type { Feature, PlanKey } from "./plan-catalog";

/**
 * SP-28 error keys, re-scoped (no Stripe): `{statusCode, message: key, …}`.
 * The frontend has copy for every key. The 402s carry a flat `code` (like
 * ADS_INSUFFICIENT_BALANCE and PAYMENT_OVERDUE) so clients can branch on it.
 */
const STATUS = {
  "billing.invalid_amount": 400,
  "billing.invalid_range": 400,
  "billing.invalid_meter": 400,
} as const;

export type BillingErrorKey = keyof typeof STATUS;
export const BILLING_ERROR_KEYS = Object.keys(STATUS) as BillingErrorKey[];
export const PLAN_REQUIRED = "PLAN_REQUIRED";
export const WALLET_EMPTY = "WALLET_EMPTY";

export function billingError(key: BillingErrorKey, extra: Record<string, unknown> = {}): HttpException {
  return new BadRequestException({ statusCode: STATUS[key], message: key, ...extra });
}

/** 402: the workspace's plan does not include the feature. */
export function planRequired(feature: Feature, requiredPlan: PlanKey | null): HttpException {
  return new HttpException(
    { statusCode: 402, code: PLAN_REQUIRED, message: "billing.plan_required", feature, requiredPlan },
    402,
  );
}

/** 402: the wallet cannot cover a debit (new meters never drain to zero). */
export class WalletEmptyError extends HttpException {
  constructor(readonly balanceJod: string, readonly requiredJod: string) {
    super({ statusCode: 402, code: WALLET_EMPTY, message: "billing.wallet_empty", balanceJod, requiredJod }, 402);
  }
}
