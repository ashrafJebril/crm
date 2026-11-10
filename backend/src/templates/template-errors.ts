import { BadRequestException, ConflictException, HttpException, NotFoundException } from "@nestjs/common";

/**
 * SP-14 template error keys, same `{statusCode, message: key, …extra}`
 * shape as `campaignError` and `channelError` (the frontend maps the key
 * through `tx`). `templates.header_media_required` predates this file
 * (templates.service.ts, HEADER_MEDIA_REQUIRED).
 *
 * The copy-to-number keys (`number_invalid`, `copy_requires_approved`,
 * `already_on_number`, `copy_unsupported`) are reserved for the deferred
 * "Copy to number" route (ruling 11(b), dropped from Task 2 to a follow-up).
 */
export type TemplateErrorKey =
  | "templates.not_found"
  | "templates.number_invalid"
  | "templates.copy_requires_approved"
  | "templates.already_on_number"
  | "templates.copy_unsupported";

const STATUS: Record<TemplateErrorKey, 400 | 404 | 409> = {
  "templates.not_found": 404,
  "templates.number_invalid": 400, // {channelId}
  "templates.copy_requires_approved": 400,
  "templates.already_on_number": 409, // {status}
  "templates.copy_unsupported": 400, // {provider}
};

export function templateError(key: TemplateErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 404) return new NotFoundException(body);
  if (statusCode === 409) return new ConflictException(body);
  return new BadRequestException(body);
}
