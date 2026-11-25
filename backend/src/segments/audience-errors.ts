import { BadRequestException, ConflictException, HttpException, NotFoundException } from "@nestjs/common";

/**
 * SP-16 audience error keys. The `message` is the key itself (the frontend
 * maps it through `tx`), the same `{statusCode, message: key, ...extra}` shape
 * as `campaignError` (campaigns/campaign-errors.ts).
 */
export type AudienceErrorKey =
  | "audiences.not_found"
  | "audiences.reference_not_found"
  | "audiences.invalid_rules"
  | "audiences.rule_cycle"
  | "audiences.rules_too_large"
  | "audiences.rule_too_deep"
  | "audiences.not_smart"
  | "audiences.not_manual"
  | "audiences.version_conflict"
  | "audiences.in_use"
  | "audiences.in_use_by_campaigns";

const STATUS: Record<AudienceErrorKey, 400 | 404 | 409> = {
  "audiences.not_found": 404,
  "audiences.reference_not_found": 404, // {field, id}
  "audiences.invalid_rules": 400, // {path, reason}
  "audiences.rule_cycle": 400, // {path}
  "audiences.rules_too_large": 400, // {max}
  "audiences.rule_too_deep": 400, // {max}
  "audiences.not_smart": 400,
  "audiences.not_manual": 400,
  "audiences.version_conflict": 409, // {current: AudienceRow}
  "audiences.in_use": 409, // {audiences, campaigns} (Task 2)
  "audiences.in_use_by_campaigns": 409, // {campaigns} (Task 2)
};

export function audienceError(key: AudienceErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 404) return new NotFoundException(body);
  if (statusCode === 409) return new ConflictException(body);
  return new BadRequestException(body);
}

/** `audiences.not_found`, still a NotFoundException; `error` keeps the pre-SP-16 text. */
export function audienceNotFound(): HttpException {
  return audienceError("audiences.not_found", { error: "Segment not found" });
}

/** The body of an audience HttpException (for specs and callers that inspect the key). */
export function audienceErrorBody(e: unknown): Record<string, unknown> | null {
  if (!(e instanceof HttpException)) return null;
  const r = e.getResponse();
  return typeof r === "object" && r !== null ? (r as Record<string, unknown>) : null;
}
