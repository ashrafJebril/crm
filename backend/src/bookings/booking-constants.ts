/**
 * SP-10 booking constants (Global Constraints). Mirrored in the frontend's
 * src/screens/calendar/bookingConstants.ts; booking-constants.spec.ts pins
 * the values.
 */
export const SLOT_STEP_MIN = 15;
export const MAX_DAYS_AHEAD = 365;
export const MAX_WINDOWS_PER_DAY = 3;
export const MAX_LIST_RANGE_DAYS = 92;
export const SERVICE_DURATION_MIN = 5;
export const SERVICE_DURATION_MAX = 1440;
export const MAX_PROPOSED_SERVICES = 100;
export const MAX_PROPOSED_STAFF = 50;
export const MAX_CATALOG_SOURCE_CHARS = 200_000;
export const MAX_CATALOG_FILE_ROWS = 2_000;

/**
 * The booking writer's interactive transaction (SP-10 live fix F1). Writers
 * on one resource queue on its advisory lock inside the transaction, so
 * Prisma's default 5 s timeout expired for the ~6th of 10 parallel requests
 * (P2028 → 500). 20 s covers 10 queued writers at production round trips;
 * maxWait bounds waiting for a pooled connection to start one.
 */
export const BOOKING_TX_TIMEOUT_MS = 20_000;
export const BOOKING_TX_MAX_WAIT_MS = 10_000;

/** The StageColor keys (pipelines/stage-draft.ts STAGE_COLORS). */
export { STAGE_COLORS as BOOKING_COLORS } from "../pipelines/stage-draft";

/** Upper bounds on free text in the catalog. */
export const MAX_NAME_LENGTH = 120;
export const MAX_ROLE_LENGTH = 80;
/** Prices are DECIMAL(12,2): up to 10 integer digits and 2 decimals. */
export const PRICE_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;
/** ISO 4217 code. */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;
