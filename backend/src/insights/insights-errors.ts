import { BadRequestException, HttpException, NotFoundException } from "@nestjs/common";

/**
 * SP-11 error keys. Same shape as `channel-errors.ts` / `ad-errors.ts`: the
 * `message` is the key itself (the frontend maps it through `tx`).
 */
export type InsightsErrorKey = "insights.range_invalid" | "insights.channel_not_found" | "insights.pipeline_not_found";

const STATUS: Record<InsightsErrorKey, 400 | 404> = {
  "insights.range_invalid": 400,
  "insights.channel_not_found": 404,
  "insights.pipeline_not_found": 404,
};

export const INSIGHTS_ERROR_KEYS = Object.keys(STATUS) as InsightsErrorKey[];

export function insightsError(key: InsightsErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  return statusCode === 404 ? new NotFoundException(body) : new BadRequestException(body);
}
