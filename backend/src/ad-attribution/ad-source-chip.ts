/**
 * SP-15: the attribution chip on a conversation (`GET /conversations` rows
 * and `GET /conversations/:id`). Never carries `ctwaClid` or spend.
 */
export interface AdSourceChip {
  id: string;
  /** Meta's ad id: the label of an ad with no name or headline ("Ad <sourceId>"). */
  sourceId: string;
  sourceType: string;
  headline: string | null;
  adName: string | null;
  mediaType: string | null;
  /** Our re-hosted copy when there is one, else Meta's signed link (may have expired), else null. */
  imageUrl: string | null;
}

/** The one `include: {adSource: {select}}` the conversation queries use. */
export const AD_SOURCE_CHIP_SELECT = {
  id: true,
  sourceId: true,
  sourceType: true,
  headline: true,
  adName: true,
  mediaType: true,
  mediaId: true,
  mediaUrl: true,
} as const;

export interface AdSourceChipRow {
  id: string;
  sourceId: string;
  sourceType: string;
  headline: string | null;
  adName: string | null;
  mediaType: string | null;
  mediaId: string | null;
  mediaUrl: string | null;
}

export function adImageUrl(row: { mediaId: string | null; mediaUrl: string | null }): string | null {
  if (row.mediaId) return `/api/media/${encodeURIComponent(row.mediaId)}/file`;
  return row.mediaUrl ?? null;
}

export function toAdSourceChip(row: AdSourceChipRow | null | undefined): AdSourceChip | null {
  if (!row) return null;
  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceType: row.sourceType,
    headline: row.headline ?? null,
    adName: row.adName ?? null,
    mediaType: row.mediaType ?? null,
    imageUrl: adImageUrl(row),
  };
}
