import { BadRequestException } from "@nestjs/common";
import { HEADER_LIMITS } from "../integrations/template-header";

/**
 * SP-17: agent-facing media details (title, alt text, tags, "use when") and
 * the approval rules. Pure: no Prisma, no Nest services. The frontend mirror
 * is `src/components/media/mediaDetails.ts`.
 */

/** Character limits, after trimming. */
export const MEDIA_DETAIL_LIMITS = {
  title: 120,
  alt: 500,
  useWhen: 500,
  tag: 40,
  tags: 20,
} as const;

/** The only types the agent may list and send (ruling 3: WhatsApp images). */
export const AGENT_PHOTO_MIMES: readonly string[] = ["image/jpeg", "image/png"];
/** WhatsApp's image limit, shared with template headers so the two cannot drift. */
export const AGENT_PHOTO_MAX_BYTES = HEADER_LIMITS.image;
/** Lifetime of a `list_photos` URL (ruling 9): covers a slow l turn and a channel fetch. */
export const AGENT_PHOTO_URL_TTL_S = 24 * 60 * 60;
/** Search: at most this many whitespace tokens are used. */
export const MAX_SEARCH_TOKENS = 5;

export type ApprovalBlock = "type" | "size" | "inbound";

export interface MediaDetailsInput {
  title?: string | null;
  alt?: string | null;
  tags?: string[] | null;
  useWhen?: string | null;
  approvedForAgent?: boolean;
}

export interface MediaDetailsData {
  title?: string | null;
  alt?: string | null;
  tags?: string[];
  useWhen?: string | null;
  approvedForAgent?: boolean;
}

/** A 400 shaped like the global ValidationPipe's, so the client handles one shape. */
function validationError(message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, message: [message], error: "Bad Request" });
}

/** One tag as stored: trimmed, Latin letters lowercased. Arabic is kept as typed. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLocaleLowerCase("en");
}

/**
 * Trim, lowercase Latin letters, drop empty tags and duplicates (the first
 * kept). Each tag ≤ 40 chars; more than 20 after normalisation → 400.
 */
export function normalizeTags(input: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of input ?? []) {
    const tag = normalizeTag(String(raw));
    if (!tag || out.includes(tag)) continue;
    if (tag.length > MEDIA_DETAIL_LIMITS.tag) {
      throw validationError(`each value in tags must be shorter than or equal to ${MEDIA_DETAIL_LIMITS.tag} characters`);
    }
    out.push(tag);
  }
  if (out.length > MEDIA_DETAIL_LIMITS.tags) {
    throw validationError(`tags must contain no more than ${MEDIA_DETAIL_LIMITS.tags} elements`);
  }
  return out;
}

function text(value: string | null, field: "title" | "alt" | "useWhen"): string | null {
  if (value == null) return null;
  const t = String(value).trim();
  if (!t) return null;
  if (t.length > MEDIA_DETAIL_LIMITS[field]) {
    throw validationError(`${field} must be shorter than or equal to ${MEDIA_DETAIL_LIMITS[field]} characters`);
  }
  return t;
}

/**
 * The Prisma update data for a PATCH body: an absent field stays untouched,
 * `""` (or null) clears a text field to null, tags are normalised.
 */
export function normalizeDetails(dto: MediaDetailsInput): MediaDetailsData {
  const data: MediaDetailsData = {};
  if (dto.title !== undefined) data.title = text(dto.title, "title");
  if (dto.alt !== undefined) data.alt = text(dto.alt, "alt");
  if (dto.useWhen !== undefined) data.useWhen = text(dto.useWhen, "useWhen");
  if (dto.tags !== undefined) data.tags = normalizeTags(dto.tags);
  if (dto.approvedForAgent !== undefined) data.approvedForAgent = dto.approvedForAgent;
  return data;
}

/**
 * Why a file cannot be approved for the agent (ruling 3), or null when it can:
 * not JPEG/PNG → type; over 5 MB → size; an inbound customer attachment
 * (no uploader) → inbound.
 */
export function approvalBlock(row: {
  mimeType: string;
  sizeBytes: number;
  uploadedById: string | null;
}): ApprovalBlock | null {
  if (!AGENT_PHOTO_MIMES.includes(String(row.mimeType).toLowerCase())) return "type";
  if (row.sizeBytes > AGENT_PHOTO_MAX_BYTES) return "size";
  if (row.uploadedById == null) return "inbound";
  return null;
}

/** True when the agent may list and send this row right now (read and send paths). */
export function isAgentPhoto(row: { approvedForAgent: boolean; mimeType: string; sizeBytes: number }): boolean {
  return (
    row.approvedForAgent === true &&
    AGENT_PHOTO_MIMES.includes(String(row.mimeType).toLowerCase()) &&
    row.sizeBytes <= AGENT_PHOTO_MAX_BYTES
  );
}

/** Search tokens: trimmed, split on whitespace, at most 5 (ruling 7). */
export function searchTokens(q: string | null | undefined): string[] {
  return String(q ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TOKENS);
}
