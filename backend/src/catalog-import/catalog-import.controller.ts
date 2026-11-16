import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import type { Response } from "express";
import { CurrentUserId, CurrentWorkspace } from "../common/current-workspace.decorator";
import { MAX_IMPORT_BYTES } from "../imports/parse-file";
import { catalogImportError } from "./catalog-import-errors";
import { CatalogImportService } from "./catalog-import.service";
import { buildTemplate, type TemplateKind } from "./templates";

/**
 * SP-10 catalog import. Permissions (permission-map.ts): `bookings.manage`
 * for everything except the template download (`bookings.view`).
 * `templates/:kind` is declared before `:id`. Bodies are validated in the
 * service (JSON or multipart), so every refusal carries a catalog_import key.
 */
@Controller("catalog-imports")
export class CatalogImportController {
  constructor(private readonly svc: CatalogImportService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor("file", {
      // In memory (≤ 10 MB) and parsed at once; the file itself is never stored.
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMPORT_BYTES + 1024 * 1024 },
    }),
  )
  create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (file && file.size > MAX_IMPORT_BYTES) throw catalogImportError("catalog_import.file_invalid");
    return this.svc.create(workspaceId, userId, {
      source: body?.source,
      kind: body?.kind,
      text: body?.text,
      url: body?.url,
      file: file ? { buffer: file.buffer, originalname: file.originalname } : undefined,
    });
  }

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Get("templates/:kind")
  async template(@Param("kind") kind: string, @Res() res: Response) {
    if (kind !== "services" && kind !== "staff") throw catalogImportError("catalog_import.source_invalid", { field: "kind" });
    const buf = await buildTemplate(kind as TemplateKind);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="catalog-' + kind + '-template.xlsx"');
    res.send(buf);
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.get(workspaceId, id);
  }

  @Patch(":id/items")
  patchItems(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.svc.patchItems(workspaceId, id, body?.items);
  }

  @Post(":id/run")
  run(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.run(workspaceId, id);
  }

  @Post(":id/cancel")
  cancel(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.cancel(workspaceId, id);
  }
}
