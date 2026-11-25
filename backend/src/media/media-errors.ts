import { BadRequestException, ConflictException, HttpException } from "@nestjs/common";

/**
 * SP-13 media error keys. Same shape as `campaign-errors.ts`: the `message`
 * is the key itself (the frontend maps it through `tx`), extras ride along.
 * "Media not found" (404) is unchanged on purpose: other modules match it.
 */
export type MediaErrorKey =
  | "media.no_file"
  | "media.type_mismatch"
  | "media.unsupported_type" // {allowed}
  | "media.too_large" // {limit}
  | "media.invalid_query" // {param}
  | "media.in_use" // {templates, campaigns, tickets, knowledge}
  // SP-17
  | "media.no_changes"
  | "media.not_approvable" // {reason: "type" | "size" | "inbound"}
  | "media.title_required";

const STATUS: Record<MediaErrorKey, 400 | 409> = {
  "media.no_file": 400,
  "media.type_mismatch": 400,
  "media.unsupported_type": 400,
  "media.too_large": 400,
  "media.invalid_query": 400,
  "media.in_use": 409,
  "media.no_changes": 400,
  "media.not_approvable": 400,
  "media.title_required": 400,
};

export function mediaError(key: MediaErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 409) return new ConflictException(body);
  return new BadRequestException(body);
}
