import {
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { memoryStorage } from "multer";
import { MediaService } from "./media.service";
import {
  CurrentWorkspace,
  CurrentUserId,
} from "../common/current-workspace.decorator";
import { Public } from "../auth/public.decorator";

@Controller("media")
export class MediaController {
  constructor(private readonly svc: MediaService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      // Buffer the file in memory and hand off to MediaService.finalizeUpload,
      // which writes to whichever storage backend is active (LocalStorage or
      // SpacesStorage). 20 MB cap matches MediaService validation.
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
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
  ) {
    const resolved = await this.svc.resolveServe(workspaceId, id);
    if (resolved.kind === "signed-url") {
      // Proxy the bytes instead of 302-redirecting. The frontend's fetch()
      // sends an Authorization header, which triggers a CORS preflight on
      // the redirect target — and DO Spaces' header allowlist doesn't
      // include `authorization`. Streaming through the backend keeps the
      // browser same-origin so CORS never enters the picture. Cost: one
      // extra hop. For 20 MB-capped images, negligible.
      const upstream = await fetch(resolved.url);
      if (!upstream.ok) {
        throw new NotFoundException(
          `Upstream fetch failed (${upstream.status})`,
        );
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", resolved.mimeType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.send(buf);
    }
    res.setHeader("Content-Type", resolved.mimeType);
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
    res.setHeader("Content-Type", resolved.mimeType);
    res.setHeader("Cache-Control", "public, max-age=900");
    res.sendFile(resolved.absolutePath);
  }

  @Delete(":id")
  remove(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
  ) {
    return this.svc.remove(workspaceId, id);
  }
}
