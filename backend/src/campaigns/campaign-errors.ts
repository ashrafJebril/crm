import { BadRequestException, HttpException, NotFoundException } from "@nestjs/common";

/**
 * SP-12 error keys. The `message` is the key itself (the frontend maps it
 * through `tx`), the same convention as `channels.*` (channel-errors.ts).
 */
export type CampaignErrorKey =
  | "campaigns.not_found"
  | "campaigns.recipient_not_found"
  | "campaigns.invalid_cursor"
  | "campaigns.invalid_status"
  | "campaigns.invalid_limit"
  | "campaigns.ids_too_many"
  | "campaigns.follow_up_target"
  | "campaigns.follow_up_too_large"
  | "campaigns.group_name_required";

const STATUS: Record<CampaignErrorKey, 400 | 404> = {
  "campaigns.not_found": 404,
  "campaigns.recipient_not_found": 404,
  "campaigns.invalid_cursor": 400,
  "campaigns.invalid_status": 400,
  "campaigns.invalid_limit": 400,
  "campaigns.ids_too_many": 400, // {limit}
  "campaigns.follow_up_target": 400,
  "campaigns.follow_up_too_large": 400, // {limit, count}
  "campaigns.group_name_required": 400,
};

export function campaignError(key: CampaignErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  return statusCode === 404 ? new NotFoundException(body) : new BadRequestException(body);
}
