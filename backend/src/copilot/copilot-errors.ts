import { HttpException } from "@nestjs/common";

/**
 * SP-18 copilot error keys (Global Constraints → Error keys). HTTP errors are
 * `{statusCode, message: key, ...extra}`; the frontend maps the key through
 * `tx` (`src/copilot/copilotErrors.ts`, Task 3). Stream errors are
 * `event: error` with `{code}` (STREAM_ERROR_CODES).
 */
export const COPILOT_ERROR_STATUS = {
  "copilot.message_invalid": 400, // {max}
  "copilot.too_many_refs": 400, // {max}
  "copilot.too_many_attachments": 400, // {max}
  "copilot.attachment_type": 400,
  "copilot.attachment_too_large": 400, // {maxBytes}
  "copilot.page_context_invalid": 400,
  "copilot.feedback_too_long": 400, // {max}
  "copilot.ref_not_permitted": 403, // {index}
  "copilot.permission_revoked": 403,
  "copilot.not_found": 404,
  "copilot.turn_running": 409,
  "copilot.action_closed": 409, // {status}
  "copilot.card_outdated": 409,
  "copilot.action_expired": 410,
  "copilot.rate": 429, // {retryAfterSeconds}
  "copilot.daily_limit": 429, // {retryAfterSeconds}
  "copilot.unavailable": 503,
} as const;

export type CopilotErrorKey = keyof typeof COPILOT_ERROR_STATUS;
export const COPILOT_ERROR_KEYS = Object.keys(COPILOT_ERROR_STATUS) as CopilotErrorKey[];

/** `event: error {code}` values; every stream ends with `done` or one of these. */
export const STREAM_ERROR_CODES = ["copilot.ai_failed", "copilot.refused", "copilot.limit", "copilot.timeout", "copilot.attachment_unavailable", "copilot.session_expired"] as const;
export type StreamErrorCode = (typeof STREAM_ERROR_CODES)[number];

export function copilotError(key: CopilotErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = COPILOT_ERROR_STATUS[key];
  return new HttpException({ statusCode, message: key, ...extra }, statusCode);
}
