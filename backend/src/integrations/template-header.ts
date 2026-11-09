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

type MediaKind = "image" | "video" | "document";

/** Mime types WhatsApp accepts per header media type. */
const MIME_BY_KIND: Record<MediaKind, string[]> = {
  image: ["image/jpeg", "image/png"],
  video: ["video/mp4"],
  document: ["application/pdf"],
};

function kindOfMime(mime: string): MediaKind | null {
  for (const k of Object.keys(MIME_BY_KIND) as MediaKind[]) if (MIME_BY_KIND[k].includes(mime)) return k;
  return null;
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
    const kind = kindOfMime(row.mimeType);
    const expected = declared ?? kind;
    if (!kind || !expected || expected !== kind || !(expected in MIME_BY_KIND)) {
      throw new BadRequestException(HEADER_MEDIA_MISMATCH);
    }
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
