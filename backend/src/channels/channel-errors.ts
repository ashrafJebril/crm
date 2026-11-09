import {
  BadRequestException,
  ConflictException,
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
  | "channels.invalid_config";

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
};

export function channelError(key: ChannelErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 404) return new NotFoundException(body);
  if (statusCode === 409) return new ConflictException(body);
  if (statusCode === 400) return new BadRequestException(body);
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
