/**
 * SP-21 knowledge constants (Global Constraints → Constants). Mirrored in
 * `src/screens/knowledge/knowledgeConstants.ts` (Task 3 pins the equality).
 */

export const KNOWLEDGE_KINDS = ["content", "faq", "guideline", "file", "typed_doc", "website"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_STATUSES = ["draft", "queued", "processing", "ready", "failed", "paused"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

/**
 * Internal, never a member-visible kind: a deleted source whose upstream
 * copies (kewy-ai doc, l document, l guidelines block) could not be removed
 * yet. The publisher's retry sweep retries it with backoff, then drops it.
 * Listing and loading exclude it; every other reader filters on a real kind
 * or on `status: "ready"`, which a tombstone (`status: "deleted"`) never has.
 */
export const TOMBSTONE_KIND = "tombstone";

export const PAGE_STATES = ["synced", "needs_login", "blocked", "removed", "error", "capped"] as const;
export type PageState = (typeof PAGE_STATES)[number];

export const SCHEDULES = ["daily", "weekly", "monthly", "manual"] as const;
export type Schedule = (typeof SCHEDULES)[number];

export const TYPED_KINDS = ["offers", "inventory", "packages"] as const;
export type TypedKind = (typeof TYPED_KINDS)[number];

export const FAQ_QUESTION_MAX = 300;
export const FAQ_ANSWER_MAX = 2000;
export const FAQ_MAX = 500;
export const GUIDELINES_MAX = 4000;
/** Derived text of the business content. */
export const KNOWLEDGE_CONTENT_MAX = 100_000;

export const KB_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const KB_BATCH_MAX = 10;
export const KB_FILE_TYPES = ["pdf", "xlsx", "csv", "jpeg", "png", "webp"] as const;
export type KbFileType = (typeof KB_FILE_TYPES)[number];
/**
 * Pages of a PDF sent to Claude for transcription. The claude-api skill
 * allows 600 pages on 1M-context models (100 on 200k ones) within a 32 MB
 * request; the plan's lower cap is kept (cost, and 16 000 output tokens).
 */
export const KB_PDF_MAX_PAGES = 100;
/** Extracted characters kept per file. */
export const KB_TEXT_MAX = 400_000;

export const MAX_TYPED_ROWS = 2000;
export const MAX_ROW_ERRORS_REPORTED = 100;

export const WEBSITE_MAX_SOURCES = 5;
export const WEBSITE_PAGE_CAP = 50;
export const WEBSITE_LINK_DEPTH = 2;
export const WEBSITE_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const WEBSITE_FETCH_TIMEOUT_MS = 10_000;
export const WEBSITE_RUN_BUDGET_MS = 10 * 60 * 1000;
/** A website run holding its lease (`syncStartedAt`) longer than this is stale: another may take it over, and it no longer reads as syncing. */
export const WEBSITE_STALE_MS = 30 * 60 * 1000;
export const REFRESH_COOLDOWN_MS = 60 * 60 * 1000;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const REMOVED_RETENTION_DAYS = 30;
export const MAX_MISSED_RUNS = 2;
export const CRAWL_UA = "KewyKnowledgeBot/1.0 (+https://kewy.ai/bot)";

export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 10;
export const CHUNK_MAX_CHARS = 1200;
/** Chunks shorter than this are dropped (headings alone, stray lines). */
export const CHUNK_MIN_CHARS = 30;

/** A source left in `processing` this long is failed with `knowledge.processing_stalled`. */
export const PROCESSING_STALL_MS = 20 * 60 * 1000;
/** Preview items returned at most. */
export const PREVIEW_MAX_ITEMS = 200;
