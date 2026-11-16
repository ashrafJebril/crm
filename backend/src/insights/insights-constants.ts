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
export const SECTION_STATEMENT_TIMEOUT_MS = 8_000;
export const SECTION_STATEMENT_TIMEOUT = `${SECTION_STATEMENT_TIMEOUT_MS / 1000}s`;
/** Headroom on top of the statements' own timeouts (the two SET LOCALs,
 *  round trips), so Postgres cancels a slow statement before Prisma's
 *  interactive-transaction timeout (P2028) fires. */
export const SECTION_TRANSACTION_MARGIN_MS = 4_000;
/** Prisma's interactive-transaction ceiling for a section running
 *  `statements` statements: always above statement_timeout × statements. */
export function sectionTransactionTimeoutMs(statements: number): number {
  return Math.max(1, statements) * SECTION_STATEMENT_TIMEOUT_MS + SECTION_TRANSACTION_MARGIN_MS;
}
/** How long a section may wait for a pooled connection. */
export const SECTION_MAX_WAIT_MS = 5_000;
/**
 * At most this many insight sections hold a pooled connection at once, across
 * every request of this process. Prisma's default pool is num_cpus × 2 + 1
 * (3–5 on Fly); an Analytics load must never starve webhooks and sends
 * (P2024). Further sections queue in memory before taking a connection.
 */
export const MAX_CONCURRENT_SECTIONS = 2;
