import { BadRequestException, ConflictException, HttpException, NotFoundException } from "@nestjs/common";

/**
 * SP-12 and SP-13 error keys. The `message` is the key itself (the frontend
 * maps it through `tx`), the same convention as `channels.*`
 * (channel-errors.ts).
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
  | "campaigns.group_name_required"
  // SP-13
  | "campaigns.whatsapp_not_connected"
  | "campaigns.already_launched"
  | "campaigns.sender_conflict"
  | "campaigns.too_many_senders"
  | "campaigns.template_missing_on_number"
  | "campaigns.template_check_failed"
  | "campaigns.template_not_approved"
  | "campaigns.template_unsupported"
  | "campaigns.schedule_invalid"
  | "campaigns.var_map_invalid"
  | "campaigns.var_map_too_varied"
  // SP-13 final review (m3): a campaign header file forces direct sends, which stop at CAMPAIGN_DIRECT_MAX.
  | "campaigns.header_direct_too_large"
  | "campaigns.no_reachable_recipients"
  | "campaigns.header_media_schedule_too_far"
  | "campaigns.not_cancellable"
  // SP-13 Task 2: lastError of a launch that failed for a non-keyed reason (the provider text is on the partition).
  | "campaigns.launch_failed"
  // SP-13 Task 2 fix round 1 (I1): a broadcast of this campaign may still send.
  | "campaigns.has_live_broadcasts";

const STATUS: Record<CampaignErrorKey, 400 | 404 | 409 | 502> = {
  "campaigns.not_found": 404,
  "campaigns.recipient_not_found": 404,
  "campaigns.invalid_cursor": 400,
  "campaigns.invalid_status": 400,
  "campaigns.invalid_limit": 400,
  "campaigns.ids_too_many": 400, // {limit}
  "campaigns.follow_up_target": 400,
  "campaigns.follow_up_too_large": 400, // {limit, count}
  "campaigns.group_name_required": 400,
  // SP-13
  "campaigns.whatsapp_not_connected": 409, // + code: "WHATSAPP_NOT_CONNECTED"
  "campaigns.already_launched": 409,
  "campaigns.sender_conflict": 400,
  "campaigns.too_many_senders": 400, // {limit}
  "campaigns.template_missing_on_number": 400, // {channelIds}
  "campaigns.template_check_failed": 502, // {channelIds}
  "campaigns.template_not_approved": 400,
  "campaigns.template_unsupported": 400,
  "campaigns.schedule_invalid": 400,
  "campaigns.var_map_invalid": 400, // {slot, reason}
  "campaigns.var_map_too_varied": 400, // {partitions, limit, directLimit, reachable}
  "campaigns.header_direct_too_large": 400, // {limit, reachable}; a launch failure (lastError)
  "campaigns.no_reachable_recipients": 400, // a launch failure (lastError)
  "campaigns.header_media_schedule_too_far": 400, // {days: 6}
  "campaigns.not_cancellable": 400,
  "campaigns.launch_failed": 502, // a launch failure (lastError)
  "campaigns.has_live_broadcasts": 400, // DELETE refused while a partition may still send
};

/** Machine codes carried next to the key (ruling 6: the roadmap's name). */
const CODES: Partial<Record<CampaignErrorKey, string>> = {
  "campaigns.whatsapp_not_connected": "WHATSAPP_NOT_CONNECTED",
};

export function campaignError(key: CampaignErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...(CODES[key] ? { code: CODES[key] } : {}), ...extra };
  if (statusCode === 404) return new NotFoundException(body);
  if (statusCode === 409) return new ConflictException(body);
  if (statusCode === 400) return new BadRequestException(body);
  return new HttpException(body, statusCode);
}
