import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { diskStorage } from "multer";
import { tmpdir } from "node:os";
import { MEDIA_KINDS, MEDIA_LIST_MAX, MediaService, type MediaKind } from "./media.service";
import { mediaError } from "./media-errors";
import { UpdateMediaDto } from "./media.dto";
import {
  CurrentViewer,
  CurrentWorkspace,
  CurrentUserId,
} from "../common/current-workspace.decorator";
import type { Viewer } from "../permissions/visibility";
import { Public } from "../auth/public.decorator";

/** Types served inline. Everything else is a sandboxed download (SP-13). */
const INLINE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

/** Response header with the library's next-page cursor (SP-13 I2). */
export const NEXT_BEFORE_HEADER = "X-Media-Next-Before";
/** SP-17: longest accepted `GET /media?q=` (after trimming). */
export const MEDIA_QUERY_MAX = 100;

/**
 * RFC 5987 `ext-value` encoding: encodeURIComponent leaves `'`, `(`, `)` and
 * `*` alone, but they are not `attr-char`s, so strict parsers would drop the
 * whole `filename*` (and fall back to the ASCII name).
 */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Serving headers for a media response. `nosniff` always; anything that is
 * not a library image or video (PDFs, legacy CSV/XLSX, unknown types) is sent
 * as an attachment with a `sandbox` CSP, so a crafted file can never run as a
 * page on our origin.
 */
export function applyServeHeaders(
  res: Pick<Response, "setHeader">,
  mimeType: string,
  fileName?: string | null,
) {
  res.setHeader("Content-Type", mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (INLINE_TYPES.has(String(mimeType).toLowerCase())) return;
  const name = (fileName ?? "").trim() || "download";
  // ASCII fallback: printable ASCII only, no quote or backslash.
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`);
  res.setHeader("Content-Security-Policy", "sandbox");
}

@Controller("media")
export class MediaController {
  private readonly log = new Logger(MediaController.name);

  constructor(private readonly svc: MediaService) {}

  /**
   * `GET /media?kind=image|video|document|all&before=<id>&limit=1..200`.
   * With no query the response is unchanged: an array of up to 200 images and
   * videos, newest first. The body is always a plain array; the
   * `X-Media-Next-Before` header carries the cursor for the next page and is
   * absent at the true end of the list (no header = end).
   *
   * SP-17: `q` (search, trimmed, ≤ 100; empty is ignored) and
   * `approved=true|false` combine with the above; anything else is 400
   * media.invalid_query {param}.
   */
  @Get()
  list(
    @CurrentWorkspace() workspaceId: string,
    @CurrentViewer() viewer: Viewer,
    @Res({ passthrough: true }) res: Response,
    @Query("kind") kind?: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
    @Query("q") q?: string,
    @Query("approved") approved?: string,
  ) {
    if (kind !== undefined && !MEDIA_KINDS.includes(kind as MediaKind)) {
      throw mediaError("media.invalid_query", { param: "kind" });
    }
    let n: number | undefined;
    if (limit !== undefined) {
      n = /^\d+$/.test(limit) ? Number(limit) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > MEDIA_LIST_MAX) {
        throw mediaError("media.invalid_query", { param: "limit" });
      }
    }
    if (q !== undefined && (typeof q !== "string" || q.trim().length > MEDIA_QUERY_MAX)) {
      throw mediaError("media.invalid_query", { param: "q" });
    }
    if (approved !== undefined && approved !== "true" && approved !== "false") {
      throw mediaError("media.invalid_query", { param: "approved" });
    }
    const search = q?.trim();
    return this.svc
      .listPage(workspaceId, viewer, {
        kind: kind as MediaKind | undefined,
        before: before || undefined,
        limit: n,
        ...(search ? { q: search } : {}),
        ...(approved !== undefined ? { approved: approved === "true" } : {}),
      })
      .then(({ items, nextBefore }) => {
        if (nextBefore) res.setHeader(NEXT_BEFORE_HEADER, nextBefore);
        return items;
      });
  }

  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      // Stage uploads on disk (OS temp dir) instead of buffering in memory —
      // videos are capped at 300 MB and must never sit on the heap.
      // MediaService validates mime + per-type caps and cleans the temp file
      // on every exit path (accepted or rejected).
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: 300 * 1024 * 1024 },
    }),
  )
  upload(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.svc.finalizeUpload(workspaceId, file, userId);
  }

  @Get(":id/file")
  async serve(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Res() res: Response,
    @CurrentViewer() viewer: Viewer,
  ) {
    const resolved = await this.svc.resolveServe(workspaceId, id, 3600, viewer);
    if (resolved.kind === "signed-url") {
      // Proxy the bytes instead of 302-redirecting. The frontend's fetch()
      // sends an Authorization header, which triggers a CORS preflight on
      // the redirect target — and DO Spaces' header allowlist doesn't
      // include `authorization`. Streaming through the backend keeps the
      // browser same-origin so CORS never enters the picture. Cost: one
      // extra hop. Videos are capped at 300 MB, so the response is piped
      // through rather than buffered in memory.
      const upstream = await fetch(resolved.url);
      if (!upstream.ok) {
        throw new NotFoundException(
          `Upstream fetch failed (${upstream.status})`,
        );
      }
      applyServeHeaders(res, resolved.mimeType, resolved.fileName);
      res.setHeader("Cache-Control", "private, max-age=3600");
      const contentLength = upstream.headers.get("content-length");
      if (contentLength) res.setHeader("Content-Length", contentLength);
      const { Readable } = await import("node:stream");
      const { pipeline } = await import("node:stream/promises");
      try {
        await pipeline(Readable.fromWeb(upstream.body as never), res);
      } catch (e) {
        // Upstream (DO Spaces) can die mid-transfer on a large video — a
        // plain .pipe() leaves that as an unhandled stream error that kills
        // the whole process. pipeline() surfaces it here instead; headers
        // are already sent, so just destroy the response (client sees a
        // truncated/failed download) rather than trying to respond again.
        this.log.warn(
          `Media stream from Spaces failed for ${id}: ${(e as Error).message}`,
        );
        res.destroy();
      }
      return;
    }
    applyServeHeaders(res, resolved.mimeType, resolved.fileName);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(resolved.absolutePath);
  }

  @Public()
  @Get(":id/public")
  async servePublic(
    @Param("id") id: string,
    @Query("token") token: string,
    @Res() res: Response,
  ) {
    const row = await this.svc.findByPublicToken(token);
    if (!row || row.id !== id)
      throw new NotFoundException("Bad or expired token");
    const resolved = await this.svc.resolveServeForRow(row, 900);
    if (resolved.kind === "signed-url") {
      return res.redirect(302, resolved.url);
    }
    applyServeHeaders(res, resolved.mimeType, resolved.fileName);
    res.setHeader("Cache-Control", "public, max-age=900");
    res.sendFile(resolved.absolutePath);
  }

  /**
   * SP-17: edit a file's details and its agent switch (`knowledge.update`,
   * ruling 5). 404 "Media not found" for a foreign id or a file the viewer
   * cannot see; 400 media.no_changes / media.not_approvable {reason} /
   * media.title_required. Returns the updated row.
   */
  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateMediaDto,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.update(workspaceId, id, dto, viewer);
  }

  @Delete(":id")
  remove(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.remove(workspaceId, id, viewer);
  }
}
