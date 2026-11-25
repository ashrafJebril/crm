import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";

/**
 * SP-19 error keys. The `message` is the key itself (the frontend maps it
 * through `tx`), the same convention as `pipelines.version_conflict`.
 */
export type ChannelErrorKey =
  | "channels.not_found"
  | "channels.limit_reached"
  | "channels.disconnected"
  | "channels.not_connected"
  | "channels.already_connected"
  | "channels.connected_elsewhere"
  | "channels.default_requires_active"
  | "channels.default_conflict"
  | "channels.default_required"
  | "channels.sender_invalid"
  | "channels.encryption_unavailable"
  | "channels.transport_unavailable"
  | "channels.invalid_config"
  | "channels.telegram_invalid_token"
  | "channels.telegram_needs_public_url"
  | "channels.telegram_send_failed"
  | "channels.webhook_forbidden"
  | "channels.embedded_signup_unavailable"
  | "channels.embedded_signup_failed"
  | "channels.meta_token_invalid"
  | "channels.meta_no_waba"
  | "channels.meta_no_number"
  | "channels.landline_wrong_code"
  | "channels.landline_rate_limited"
  | "channels.landline_cooldown"
  | "channels.landline_number_in_use"
  | "channels.landline_invalid_input"
  | "channels.landline_wrong_state"
  | "channels.landline_meta_error"
  | "channels.zernio_reauth_required"
  | "channels.health_unsupported"
  | "channels.health_check_cooldown"
  | "channels.health_check_busy"
  | "widget.origin_forbidden"
  | "widget.rate_limited"
  | "widget.channel_unavailable"
  | "widget.visitor_forbidden"
  | "widget.invalid_message";

const STATUS: Record<ChannelErrorKey, number> = {
  "channels.not_found": 404,
  "channels.limit_reached": 409,
  "channels.disconnected": 409,
  "channels.not_connected": 409,
  "channels.already_connected": 409,
  "channels.connected_elsewhere": 409,
  "channels.default_requires_active": 409,
  "channels.default_conflict": 409,
  "channels.default_required": 400,
  "channels.sender_invalid": 400,
  "channels.encryption_unavailable": 400,
  "channels.transport_unavailable": 400,
  "channels.invalid_config": 400,
  "channels.telegram_invalid_token": 400,
  "channels.telegram_needs_public_url": 400,
  "channels.telegram_send_failed": 502,
  "channels.webhook_forbidden": 403,
  // SP-19 T4: WhatsApp embedded signup, manual connect and landline numbers.
  "channels.embedded_signup_unavailable": 400, // {reason}
  "channels.embedded_signup_failed": 400, // {step: exchange | waba | phone, metaCode?}
  "channels.meta_token_invalid": 400,
  "channels.meta_no_waba": 400,
  "channels.meta_no_number": 400,
  "channels.landline_wrong_code": 400, // {metaCode}
  "channels.landline_rate_limited": 429, // {metaCode}
  "channels.landline_cooldown": 429, // {retryAfter (s), resendAt (ISO)}
  "channels.landline_number_in_use": 400, // {metaCode}
  "channels.landline_invalid_input": 400, // {field} or {metaCode}
  "channels.landline_wrong_state": 409, // {stage}
  "channels.landline_meta_error": 502, // {metaCode}
  // SP-19 T5 fix round 1: the Zernio account needs a fresh OAuth sign-in.
  "channels.zernio_reauth_required": 409, // {platform}
  // SP-14: number health live check.
  "channels.health_unsupported": 400, // {provider}
  "channels.health_check_cooldown": 429, // {retryAfter (s), nextAt (ISO)}
  "channels.health_check_busy": 429, // {retryAfter (s)}
  // SP-19 T3: the public web chat widget.
  "widget.origin_forbidden": 403,
  "widget.rate_limited": 429,
  "widget.channel_unavailable": 404,
  "widget.visitor_forbidden": 403,
  "widget.invalid_message": 400,
};

export function channelError(key: ChannelErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 404) return new NotFoundException(body);
  if (statusCode === 409) return new ConflictException(body);
  if (statusCode === 400) return new BadRequestException(body);
  if (statusCode === 403) return new ForbiddenException(body);
  return new HttpException(body, statusCode);
}

/** The key carried by an exception thrown through `channelError`, if any. */
export function channelErrorKey(e: unknown): string | null {
  if (!(e instanceof HttpException)) return null;
  const r = e.getResponse();
  return typeof r === "object" && r !== null && typeof (r as { message?: unknown }).message === "string"
    ? ((r as { message: string }).message)
    : null;
}
