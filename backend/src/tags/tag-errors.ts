import { ConflictException, HttpException } from "@nestjs/common";

/**
 * SP-16 tag error keys, in the `{statusCode, message: key, ...extra}` shape of
 * `campaignError` and `audienceError` (the frontend maps the key through `tx`).
 */
export type TagErrorKey = "tags.in_use_by_audiences";

/**
 * 409 `tags.in_use_by_audiences {audiences}`: the tag is named by smart
 * audiences (rules or a legacy filter). `DELETE /tags/:id?confirm=1` deletes
 * it anyway and marks those rules `missing` (ruling 7).
 */
export function tagError(key: TagErrorKey, extra: Record<string, unknown> = {}): HttpException {
  return new ConflictException({ statusCode: 409, message: key, ...extra });
}
