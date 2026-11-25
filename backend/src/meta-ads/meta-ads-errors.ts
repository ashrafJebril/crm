import {
  BadRequestException,
  ConflictException,
  HttpException,
} from "@nestjs/common";

/**
 * SP-15 Meta Ads error keys. Same shape as `channel-errors.ts`: the `message`
 * is the key itself (the frontend maps it through `tx`), extras ride along.
 * No error ever carries Meta's message text or a token.
 */
export type MetaAdsErrorKey =
  | "meta_ads.not_configured" // {missing}
  | "meta_ads.encryption_unavailable"
  | "meta_ads.no_ads_permission"
  | "meta_ads.unknown_asset" // {ids}
  | "meta_ads.login_expired"
  | "meta_ads.not_exchanged"
  | "meta_ads.reconnect" // {token: "pending" | "active"}
  | "meta_ads.connection_changed"
  | "meta_ads.not_connected"
  | "meta_ads.check_cooldown" // {retryAfter (s), nextAt (ISO)}
  | "meta_ads.meta_refused"; // {graphCode}

const STATUS: Record<MetaAdsErrorKey, number> = {
  "meta_ads.not_configured": 400,
  "meta_ads.encryption_unavailable": 400,
  "meta_ads.no_ads_permission": 400,
  "meta_ads.unknown_asset": 400,
  "meta_ads.login_expired": 400,
  "meta_ads.not_exchanged": 409,
  "meta_ads.reconnect": 409,
  "meta_ads.connection_changed": 409,
  "meta_ads.not_connected": 409,
  "meta_ads.check_cooldown": 429,
  "meta_ads.meta_refused": 502,
};

export const META_ADS_ERROR_KEYS = Object.keys(STATUS) as MetaAdsErrorKey[];

export function metaAdsError(key: MetaAdsErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 400) return new BadRequestException(body);
  if (statusCode === 409) return new ConflictException(body);
  return new HttpException(body, statusCode);
}

/** The key of a `metaAdsError`, else null. */
export function metaAdsErrorKey(e: unknown): string | null {
  if (!(e instanceof HttpException)) return null;
  const r = e.getResponse();
  return typeof r === "object" && r !== null && typeof (r as { message?: unknown }).message === "string"
    ? (r as { message: string }).message
    : null;
}
