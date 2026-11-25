import { HttpException } from "@nestjs/common";

/**
 * SP-21 knowledge error keys (Global Constraints → Error keys). The response
 * body is `{statusCode, message: key, ...extra}`; the frontend maps the key
 * through `tx` (`src/screens/knowledge/knowledgeErrors.ts`).
 */
export const KNOWLEDGE_ERROR_STATUS = {
  "knowledge.content_invalid": 400,
  "knowledge.content_too_long": 400, // {max}
  "knowledge.faq_duplicate": 400,
  "knowledge.faq_too_long": 400, // {field, max}
  "knowledge.faq_limit": 400, // {limit}
  "knowledge.guidelines_too_long": 400, // {max}
  "knowledge.reorder_mismatch": 400,
  "knowledge.file_type": 400, // {fileName}
  "knowledge.file_too_large": 400, // {maxBytes, fileName}
  "knowledge.batch_too_large": 400, // {max}
  "knowledge.template_columns": 400, // {missing: string[], unknown: string[], fileName}
  "knowledge.typed_rows": 400, // {rowErrors: {row, column, error}[], total, validRows, fileName}
  "knowledge.url_invalid": 400,
  "knowledge.url_blocked": 400,
  "knowledge.not_https": 400,
  "knowledge.website_limit": 400, // {limit}
  "knowledge.not_found": 404,
  "knowledge.version_conflict": 409, // {current}
  "knowledge.website_exists": 409,
  "knowledge.syncing": 409,
  "knowledge.cooldown": 409, // {retryAfterSeconds}
} as const;

export type KnowledgeErrorKey = keyof typeof KNOWLEDGE_ERROR_STATUS;
export const KNOWLEDGE_ERROR_KEYS = Object.keys(KNOWLEDGE_ERROR_STATUS) as KnowledgeErrorKey[];

/** Values stored in `KnowledgeSource.error` (never thrown at the client, never provider text). */
export const KNOWLEDGE_SOURCE_ERRORS = [
  "knowledge.unreadable",
  "knowledge.empty",
  "knowledge.processing_stalled",
  "knowledge.ai_unavailable",
  "knowledge.ai_failed",
  "knowledge.pdf_too_long",
  "knowledge.site_unreachable",
  "knowledge.no_pages",
  "knowledge.page_no_text",
] as const;
export type KnowledgeSourceError = (typeof KNOWLEDGE_SOURCE_ERRORS)[number];

export function knowledgeError(key: KnowledgeErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = KNOWLEDGE_ERROR_STATUS[key];
  return new HttpException({ statusCode, message: key, ...extra }, statusCode);
}

/** A typed failure of a processing step; its key becomes `KnowledgeSource.error`. */
export class KnowledgeFailure extends Error {
  constructor(
    public readonly key: KnowledgeSourceError,
    /** A provider failure that may pass later (the processor retries it once). */
    public readonly transient = false,
  ) {
    super(key);
    this.name = "KnowledgeFailure";
  }
}

/** The stored error key of anything a processing step threw (unknown → `knowledge.unreadable`). */
export function failureKey(e: unknown): KnowledgeSourceError {
  return e instanceof KnowledgeFailure ? e.key : "knowledge.unreadable";
}
