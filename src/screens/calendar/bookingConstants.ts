/**
 * SP-10 booking constants: mirror of backend/src/bookings/booking-constants.ts
 * (pinned by bookingConstants.test.ts, which reads the backend file as text).
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

export const MAX_NAME_LENGTH = 120;
export const MAX_ROLE_LENGTH = 80;
/** DECIMAL(12,2): up to 10 integer digits and 2 decimals. */
export const PRICE_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** The StageColor keys the catalog uses for services and staff. */
export const BOOKING_COLORS = ["ink", "info", "ok", "warn", "bad", "accent", "human"] as const;
export type BookingColor = (typeof BOOKING_COLORS)[number];

/** Catalog import file cap (SP-03 MAX_IMPORT_BYTES). */
export const MAX_CATALOG_FILE_BYTES = 10 * 1024 * 1024;
