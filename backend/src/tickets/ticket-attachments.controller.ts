import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { diskStorage } from "multer";
import { tmpdir } from "node:os";
import { CurrentUserId, CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import type { Viewer } from "../permissions/visibility";
import { MAX_VIDEO_BYTES } from "../media/media.service";
import { TicketAttachmentsService } from "./ticket-attachments.service";
import { AttachTicketFileDto } from "./tickets.dto";

/**
 * SP-09 ticket attachments. Permissions come from permission-map.ts
 * (tickets.view to read, tickets.update to change). `candidates` and `upload`
 * are declared before `:attId` (Global Constraints → Route order).
 */
@Controller("tickets/:id/attachments")
export class TicketAttachmentsController {
  constructor(private readonly svc: TicketAttachmentsService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @CurrentViewer() viewer: Viewer) {
    return this.svc.list(workspaceId, id, viewer);
  }

  @Get("candidates")
  candidates(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @CurrentViewer() viewer: Viewer) {
    return this.svc.candidates(workspaceId, id, viewer);
  }

  @Post()
  attach(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body() dto: AttachTicketFileDto,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.attach(workspaceId, id, dto.mediaId, viewer, userId);
  }

  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      // Staged on disk like POST /media/upload; MediaService validates the
      // type and per-type cap and removes the temp file on every exit path.
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: MAX_VIDEO_BYTES },
    }),
  )
  upload(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.svc.upload(workspaceId, id, file, userId);
  }

  @Get(":attId")
  serve(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Param("attId") attId: string,
    @Res() res: Response,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.serve(workspaceId, id, attId, res, viewer);
  }

  @Delete(":attId")
  unlink(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Param("attId") attId: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.unlink(workspaceId, id, attId, viewer);
  }
}
