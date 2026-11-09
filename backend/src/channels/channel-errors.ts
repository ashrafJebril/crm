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
