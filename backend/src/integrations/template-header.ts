import { BadRequestException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import type { MediaService } from "../media/media.service";
import type { Viewer } from "../permissions/visibility";

export const HEADER_MEDIA_MISMATCH = "templates.header_media_mismatch";

/** What a send request may carry for a template header. */
export interface TemplateHeaderInput {
  /** Library media id for IMAGE / VIDEO / DOCUMENT headers. */
  mediaId?: string;
  /** `{{n}}` values for a TEXT header. */
  params?: string[];
}

export interface ResolvedTemplateHeader {
  /** Meta Cloud API send-shape header component. */
  component: { type: "header"; parameters: Array<Record<string, unknown>> };
  /** Library media id to attach to the stored message (media headers only). */
  attach?: string;
}

export const HEADER_MEDIA_TOO_LARGE = "templates.header_media_too_large";

export type HeaderMediaKind = "image" | "video" | "document";

/** Mime types WhatsApp accepts per header media type. */
const MIME_BY_KIND: Record<HeaderMediaKind, string[]> = {
  image: ["image/jpeg", "image/png"],
  video: ["video/mp4"],
  document: ["application/pdf"],
};

/**
 * SP-13 (ruling 7): WhatsApp's header file limits, in bytes. The library takes
 * larger files (images 20 MB, video 300 MB for social posts), so these are
 * checked where a file is used as a header, never at upload.
 */
export const HEADER_LIMITS: Record<HeaderMediaKind, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};

export function headerKindOfMime(mime: string): HeaderMediaKind | null {
  for (const k of Object.keys(MIME_BY_KIND) as HeaderMediaKind[]) if (MIME_BY_KIND[k].includes(mime)) return k;
  return null;
}

/**
 * Check a library file for use as a WhatsApp header of `expected` kind (a
 * template's headerType; null infers it from the mime). Returns the kind.
 * - wrong kind, or a type WhatsApp refuses for headers (webp, gif, quicktime)
 *   → 400 templates.header_media_mismatch;
 * - over HEADER_LIMITS → 400 templates.header_media_too_large {limit}.
 * Used by inbox template sends, the template editor and campaign launch.
 */
export function assertHeaderMedia(
  row: { mimeType: string; sizeBytes?: number | null },
  expected: string | null | undefined,
): HeaderMediaKind {
  const kind = headerKindOfMime(row.mimeType);
  const want = expected ? expected.toLowerCase() : kind;
  if (!kind || !want || want !== kind) throw new BadRequestException(HEADER_MEDIA_MISMATCH);
  const limit = HEADER_LIMITS[kind];
  if ((row.sizeBytes ?? 0) > limit) {
    throw new BadRequestException({ statusCode: 400, message: HEADER_MEDIA_TOO_LARGE, limit });
  }
  return kind;
}

/**
 * Turn the optional `header` of a template send into the Meta header component.
 * - media: workspace-verified through MediaService.get (foreign id -> 404), and
 *   its mime type must match the template's header type (400
 *   templates.header_media_mismatch). Without a local Template row the type is
 *   inferred from the mime.
 * - params: only for TEXT headers.
 * The Template row is matched on (name, language) since the same name exists
 * per language, and media is read as the sending viewer so visibility applies.
 */
export async function resolveTemplateHeader(
  deps: { prisma: Pick<PrismaService, "template">; media: Pick<MediaService, "get" | "resolveExternalUrl"> },
  workspaceId: string,
  templateName: string,
  header: TemplateHeaderInput | undefined,
  opts: { language?: string; viewer?: Viewer } = {},
): Promise<ResolvedTemplateHeader | undefined> {
  const mediaId = header?.mediaId?.trim();
  const params = (header?.params ?? []).filter((p) => typeof p === "string");
  if (!mediaId && params.length === 0) return undefined;

  const tpl = await deps.prisma.template.findFirst({
    where: { workspaceId, name: templateName, ...(opts.language ? { lang: opts.language } : {}) },
    select: { headerType: true },
  });
  const declared = tpl?.headerType ? tpl.headerType.toLowerCase() : null;

  if (mediaId) {
    const row = await deps.media.get(workspaceId, mediaId, opts.viewer); // 404 across workspaces
    // Kind must match the template's header; size within WhatsApp's limit.
    const kind = assertHeaderMedia(row, declared);
    const link = await deps.media.resolveExternalUrl(workspaceId, mediaId, 60 * 60);
    return {
      component: { type: "header", parameters: [{ type: kind, [kind]: { link } }] },
      attach: mediaId,
    };
  }

  if (declared && declared !== "text") throw new BadRequestException(HEADER_MEDIA_MISMATCH);
  return {
    component: { type: "header", parameters: params.map((text) => ({ type: "text", text })) },
  };
}
