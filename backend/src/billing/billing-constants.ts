import { loadMinBalanceJod } from "../ads/ads-pricing";
import { PAYMENT_GRACE_DAYS } from "./payment-lock";

/** R11: the existing lock grace (no automatic downgrade). */
export const BILLING_GRACE_DAYS = PAYMENT_GRACE_DAYS;
/** `GET /billing/status` per-workspace cache. */
export const STATUS_CACHE_MS = 30_000;
/** The wallet's low-balance threshold: the ads pre-spend minimum (env ADS_MIN_BALANCE_JOD). */
export const lowBalanceJod = () => loadMinBalanceJod();
/** Ledger page size. */
export const LEDGER_PAGE = 50;
/** The longest usage range one request may ask for. */
export const USAGE_MAX_RANGE_DAYS = 92;
