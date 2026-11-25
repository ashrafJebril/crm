/**
 * SP-21 knowledge constants, mirrored from
 * backend/src/knowledge-sources/knowledge-constants.ts.
 * knowledgeConstants.test.ts pins them to the backend file.
 */

export const KNOWLEDGE_KINDS = ["content", "faq", "guideline", "file", "typed_doc", "website"] as const;
export const KNOWLEDGE_STATUSES = ["draft", "queued", "processing", "ready", "failed", "paused"] as const;
export const PAGE_STATES = ["synced", "needs_login", "blocked", "removed", "error", "capped"] as const;
export const SCHEDULES = ["daily", "weekly", "monthly", "manual"] as const;
export const TYPED_KINDS = ["offers", "inventory", "packages"] as const;

export const FAQ_QUESTION_MAX = 300;
export const FAQ_ANSWER_MAX = 2000;
export const FAQ_MAX = 500;
export const GUIDELINES_MAX = 4000;
export const KNOWLEDGE_CONTENT_MAX = 100_000;

export const KB_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const KB_BATCH_MAX = 10;
export const KB_FILE_TYPES = ["pdf", "xlsx", "csv", "jpeg", "png", "webp"] as const;

export const MAX_TYPED_ROWS = 2000;
export const MAX_ROW_ERRORS_REPORTED = 100;

export const WEBSITE_MAX_SOURCES = 5;
export const WEBSITE_PAGE_CAP = 50;
export const REFRESH_COOLDOWN_MS = 60 * 60 * 1000;
export const MAX_CONSECUTIVE_FAILURES = 3;

export const PREVIEW_MAX_ITEMS = 200;

/** The file picker's accept list (ODS is refused: ruling 6). */
export const KB_ACCEPT = ".pdf,.xlsx,.csv,.jpg,.jpeg,.png,.webp";
/** Extensions the picker allows, checked again before upload. */
export const KB_EXTENSIONS = ["pdf", "xlsx", "csv", "jpg", "jpeg", "png", "webp"] as const;
/** Polling interval while a file or website is queued or processing. */
export const KNOWLEDGE_POLL_MS = 5000;
