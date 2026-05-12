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
import { diskStorage } from "multer";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { MediaService } from "./media.service";
import { CurrentWorkspace, CurrentUserId } from "../common/current-workspace.decorator";
import { Public } from "../auth/public.decorator";

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");

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
      storage: diskStorage({
        destination: (req, _file, cb) => {
          // The auth + workspace interceptor already populated req.user.
          // Multer doesn't have access to NestJS DI; we resolve workspaceId
          // from the JWT payload attached to the request.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const user = (req as any).user as { workspaceId?: string } | undefined;
          if (!user?.workspaceId) return cb(new Error("No workspace context"), "");
          const dir = path.resolve(UPLOAD_ROOT, user.workspaceId);
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname).toLowerCase().slice(0, 8);
          const id = randomBytes(8).toString("hex");
          cb(null, `${id}${ext}`);
        },
      }),
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
    const row = await this.svc.get(workspaceId, id);
    const absolute = await this.svc.resolvePath(workspaceId, id);
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(absolute);
  }

  @Public()
  @Get(":id/public")
  async servePublic(
    @Param("id") id: string,
    @Query("token") token: string,
    @Res() res: Response,
  ) {
    const row = await this.svc.findByPublicToken(token);
    if (!row || row.id !== id) throw new NotFoundException("Bad or expired token");
    const absolute = path.resolve(UPLOAD_ROOT, row.storedPath);
    // Defense-in-depth: confirm path stays under the workspace's upload dir.
    const wsRoot = path.resolve(UPLOAD_ROOT, row.workspaceId);
    if (!absolute.startsWith(wsRoot + path.sep)) {
      throw new NotFoundException("Bad path");
    }
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Cache-Control", "public, max-age=900"); // 15 min
    res.sendFile(absolute);
  }

  @Delete(":id")
  remove(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
  ) {
    return this.svc.remove(workspaceId, id);
  }
}
