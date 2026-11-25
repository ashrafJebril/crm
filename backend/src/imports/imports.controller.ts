import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { tmpdir } from "node:os";
import { readFile, unlink } from "node:fs/promises";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import type { Viewer } from "../permissions/visibility";
import { ImportsService } from "./imports.service";
import { PreviewImportDto } from "./imports.dto";
import { MAX_IMPORT_BYTES } from "./parse-file";

@Controller("imports")
export class ImportsController {
  constructor(private readonly svc: ImportsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor("file", {
      // Staged on disk, read once by the handler and always removed. The cap sits
      // just above the 10 MB rule so 10-11 MB files get the bilingual
      // imports.file_too_large key from the parser rather than a bare 413.
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: MAX_IMPORT_BYTES + 1024 * 1024 },
    }),
  )
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentViewer() viewer: Viewer,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    try {
      // Validated here, not by a DTO pipe: a pipe failure would skip this
      // handler and leak the staged temp file.
      const kind = typeof body?.kind === "string" ? body.kind : "";
      const buffer = file ? (file.buffer ?? (await readFile(file.path))) : undefined;
      return await this.svc.create(
        workspaceId,
        viewer,
        file && buffer ? { buffer, originalname: file.originalname } : undefined,
        kind,
      );
    } finally {
      if (file?.path) await unlink(file.path).catch(() => {});
    }
  }

  @Get()
  list(@CurrentWorkspace() workspaceId: string, @Query("limit") limit?: string) {
    return this.svc.list(workspaceId, limit ? Number(limit) : 10);
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.job(workspaceId, id);
  }

  @Post(":id/preview")
  preview(
    @CurrentWorkspace() workspaceId: string,
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() dto: PreviewImportDto,
  ) {
    return this.svc.preview(workspaceId, viewer, id, dto);
  }

  @Post(":id/run")
  run(@CurrentWorkspace() workspaceId: string, @CurrentViewer() viewer: Viewer, @Param("id") id: string) {
    return this.svc.run(workspaceId, viewer, id);
  }

  @Post(":id/cancel")
  cancel(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.cancel(workspaceId, id);
  }
}
