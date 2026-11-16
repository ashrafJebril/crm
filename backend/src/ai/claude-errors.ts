import Anthropic from "@anthropic-ai/sdk";

/**
 * SP-21 shared Claude client errors. Callers map these two keys to their own
 * error namespace (`knowledge.ai_unavailable`, …). Provider message text is
 * never carried: only the key, and for logs the SDK class name and status.
 */
export type ClaudeErrorKey = "ai_unavailable" | "ai_failed";

export class ClaudeFailure extends Error {
  constructor(
    public readonly key: ClaudeErrorKey,
    /** Safe to log: an SDK class name and HTTP status, or a stop reason. Never provider text. */
    public readonly detail = "",
  ) {
    super(key);
    this.name = "ClaudeFailure";
  }
}

/**
 * An SDK error → a ClaudeFailure, most specific class first (claude-api skill:
 * typed classes, never message matching). A bad key or a forbidden
 * organisation means Claude is unavailable to us; everything else (rate limit,
 * overload, 5xx, network, a 400 on our request) fails this one call.
 */
export function mapClaudeError(e: unknown): ClaudeFailure {
  if (e instanceof ClaudeFailure) return e;
  if (e instanceof Anthropic.AuthenticationError) return new ClaudeFailure("ai_unavailable", "AuthenticationError 401");
  if (e instanceof Anthropic.PermissionDeniedError) return new ClaudeFailure("ai_unavailable", "PermissionDeniedError 403");
  if (e instanceof Anthropic.RateLimitError) return new ClaudeFailure("ai_failed", "RateLimitError 429");
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ClaudeFailure("ai_failed", "APIConnectionTimeoutError");
  if (e instanceof Anthropic.APIConnectionError) return new ClaudeFailure("ai_failed", "APIConnectionError");
  if (e instanceof Anthropic.APIError) return new ClaudeFailure("ai_failed", `${e.constructor?.name ?? "APIError"} ${e.status ?? ""}`.trim());
  return new ClaudeFailure("ai_failed", (e as Error)?.name ?? "error");
}
