import {
  Body,
  Controller,
  Delete,
  Get,
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
import { applyServeHeaders, sendResolved } from "./serve-headers";
import { UpdateMediaDto } from "./media.dto";
import {
  CurrentViewer,
  CurrentWorkspace,
  CurrentUserId,
} from "../common/current-workspace.decorator";
import type { Viewer } from "../permissions/visibility";
import { Public } from "../auth/public.decorator";

/** Kept exported here for existing importers; lives in serve-headers.ts (SP-09). */
export { applyServeHeaders };

/** Response header with the library's next-page cursor (SP-13 I2). */
export const NEXT_BEFORE_HEADER = "X-Media-Next-Before";
/** SP-17: longest accepted `GET /media?q=` (after trimming). */
export const MEDIA_QUERY_MAX = 100;

@Controller("media")
export class MediaController {
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
    // The global ValidationPipe joins a repeated ?q=a&q=b into "a,b" before it
    // reaches us, so check the raw request query for the array as well.
    const rawQ = (res as unknown as { req?: { query?: Record<string, unknown> } }).req?.query?.q;
    if (
      Array.isArray(rawQ) ||
      (q !== undefined && (typeof q !== "string" || q.trim().length > MEDIA_QUERY_MAX))
    ) {
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
    // SP-09: the streaming code is shared with the ticket attachment download.
    await sendResolved(res, resolved, { cacheControl: "private, max-age=3600", label: id });
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
