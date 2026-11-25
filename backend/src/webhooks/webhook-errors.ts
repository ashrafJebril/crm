import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";

/** SP-27 webhook error keys (`{statusCode, message: key, …extra}`). */
const STATUS = {
  "webhooks.unsafe_url": 400,
  "webhooks.invalid_events": 400,
  "webhooks.url_immutable": 400,
  "webhooks.invalid_description": 400,
  "webhooks.not_found": 404,
  "webhooks.limit_reached": 409,
  "webhooks.encryption_unavailable": 503,
} as const;

export type WebhookErrorKey = keyof typeof STATUS;
export const WEBHOOK_ERROR_KEYS = Object.keys(STATUS) as WebhookErrorKey[];

export function webhookError(key: WebhookErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 400) return new BadRequestException(body);
  if (statusCode === 404) return new NotFoundException(body);
  if (statusCode === 409) return new ConflictException(body);
  return new ServiceUnavailableException(body);
}

export function webhookErrorStatus(key: WebhookErrorKey): number {
  return STATUS[key];
}
