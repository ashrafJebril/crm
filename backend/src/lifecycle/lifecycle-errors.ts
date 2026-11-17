import { BadRequestException, ConflictException, HttpException, NotFoundException } from "@nestjs/common";

/**
 * SP-24 error keys: `{statusCode, message: key, …extra}` like `channelError`
 * (the frontend maps the key through `tx`).
 */
export type LifecycleErrorKey =
  | "lifecycle.invalid_recipient"
  | "lifecycle.invalid_offset"
  | "lifecycle.unknown_key"
  | "lifecycle.not_set_up"
  | "lifecycle.template_rejected"
  | "lifecycle.template_missing"
  | "lifecycle.whatsapp_not_connected"
  | "workflows.system_locked";

const STATUS: Record<LifecycleErrorKey, 400 | 404 | 409> = {
  "lifecycle.invalid_recipient": 400,
  "lifecycle.invalid_offset": 400,
  "lifecycle.unknown_key": 404,
  "lifecycle.not_set_up": 409,
  "lifecycle.template_rejected": 409,
  "lifecycle.template_missing": 409,
  "lifecycle.whatsapp_not_connected": 409,
  "workflows.system_locked": 409,
};

export const LIFECYCLE_ERROR_KEYS = Object.keys(STATUS) as LifecycleErrorKey[];

export function lifecycleError(key: LifecycleErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 400) return new BadRequestException(body);
  if (statusCode === 404) return new NotFoundException(body);
  return new ConflictException(body);
}
