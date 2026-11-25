import { BadRequestException, HttpException, NotFoundException } from "@nestjs/common";

/**
 * SP-15 ad-source error keys. Same shape as `channel-errors.ts`: the
 * `message` is the key itself (the frontend maps it through `tx`), extras
 * ride along.
 */
export type AdsErrorKey = "ads.not_found" | "ads.range_invalid";

const STATUS: Record<AdsErrorKey, 400 | 404> = {
  "ads.not_found": 404,
  "ads.range_invalid": 400,
};

export const ADS_ERROR_KEYS = Object.keys(STATUS) as AdsErrorKey[];

export function adsError(key: AdsErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  return statusCode === 404 ? new NotFoundException(body) : new BadRequestException(body);
}
