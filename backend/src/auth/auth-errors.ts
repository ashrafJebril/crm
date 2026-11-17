import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

/** SP-26 auth error keys and their HTTP status (`{statusCode, message: key,
 *  …extra}`, like channelError). The frontend has copy for every key. */
const STATUS = {
  "auth.password_too_short": 400,
  "auth.2fa_code_invalid": 400,
  "auth.session_expired": 401,
  "auth.2fa_challenge_invalid": 401,
  "auth.2fa_already_enabled": 409,
  "auth.2fa_not_enabled": 409,
  "auth.reset_invalid": 410,
  "auth.rate_limited": 429,
  "auth.encryption_unavailable": 503,
} as const;

export type AuthErrorKey = keyof typeof STATUS;
export const AUTH_ERROR_KEYS = Object.keys(STATUS) as AuthErrorKey[];

export function authError(key: AuthErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 400) return new BadRequestException(body);
  if (statusCode === 401) return new UnauthorizedException(body);
  if (statusCode === 409) return new ConflictException(body);
  if (statusCode === 503) return new ServiceUnavailableException(body);
  return new HttpException(body, statusCode);
}

export function authErrorStatus(key: AuthErrorKey): number {
  return STATUS[key];
}
