/**
 * SP-11 metric constants. Each is a product decision written once here and
 * read by the SQL builders, the test oracle and (as copy) the frontend.
 */

/** AI-only resolution: no staff message in this window before `resolvedAt`
 *  (ruling 3). Also bounds the exchange that a handling time starts from. */
export const RESOLUTION_LOOKBACK_DAYS = 7;
/** The same window as a Postgres interval literal (a constant, never input). */
export const RESOLUTION_LOOKBACK = `${RESOLUTION_LOOKBACK_DAYS} days`;

/** Time saved per customer message the AI answered first: 2 × 30 s (Tkana
 *  PLT-1717). A deliberate approximation, returned with its raw count. */
export const SECONDS_SAVED_PER_MESSAGE = 60;

/** Topic friction lists a topic only from this many decided conversations… */
export const TOPIC_MIN_CONVERSATIONS = 3;
/** …and at most this many topics. */
export const TOP_TOPICS = 10;

/** Range bounds (`YYYY-MM-DD`, inclusive, workspace-local). */
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;

/** Every section runs in its own transaction with these settings (Tkana D9). */
export const SECTION_STATEMENT_TIMEOUT = "8s";
/** Prisma's interactive-transaction ceiling; above the statement timeout so
 *  Postgres cancels first and the section reports `unavailable`. */
export const SECTION_TRANSACTION_TIMEOUT_MS = 15_000;
