import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

/** SP-27 API key error keys and their HTTP status (`{statusCode, message:
 *  key, …extra}`, like authError). The frontend has copy for every key. */
const STATUS = {
  "api_keys.scope_not_allowed": 400,
  "api_keys.invalid_expiry": 400,
  "api_keys.invalid_name": 400,
  /** One key for every reason a key is refused (unknown, revoked, expired,
   *  creator gone): no oracle. */
  "api_keys.invalid": 401,
  "api_keys.route_not_allowed": 403,
  "api_keys.scope_above_role": 403,
  "api_keys.not_found": 404,
  "api_keys.limit_reached": 409,
  "api_keys.rate_limited": 429,
} as const;

export type ApiKeyErrorKey = keyof typeof STATUS;
export const API_KEY_ERROR_KEYS = Object.keys(STATUS) as ApiKeyErrorKey[];

export function apiKeyError(key: ApiKeyErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 400) return new BadRequestException(body);
  if (statusCode === 401) return new UnauthorizedException(body);
  if (statusCode === 403) return new ForbiddenException(body);
  if (statusCode === 404) return new NotFoundException(body);
  if (statusCode === 409) return new ConflictException(body);
  return new HttpException(body, statusCode);
}

export function apiKeyErrorStatus(key: ApiKeyErrorKey): number {
  return STATUS[key];
}
