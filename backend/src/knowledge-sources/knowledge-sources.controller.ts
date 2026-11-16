import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import type { Response } from "express";
import { CurrentUserId, CurrentWorkspace } from "../common/current-workspace.decorator";
import { KB_BATCH_MAX, KB_FILE_MAX_BYTES } from "./knowledge-constants";
import { knowledgeError } from "./knowledge-errors";
import {
  CreateFaqDto,
  ListPagesQuery,
  ListSourcesQuery,
  PatchFaqDto,
  PutContentDto,
  PutGuidelinesDto,
  ReorderFaqsDto,
  UploadFilesDto,
} from "./knowledge-sources.dto";
import { KnowledgeSourcesService } from "./knowledge-sources.service";
import { isTypedKind } from "./typed-docs";
import { buildTypedTemplate, templateFileName } from "./typed-templates";

/**
 * SP-21 knowledge routes (Task 1; Task 2 adds the website routes).
 * Permissions live in permission-map.ts (`knowledge.*`). Every route is
 * workspace-scoped; a foreign id is 404 `knowledge.not_found`.
 * Route order: `faqs/reorder` before `faqs/:id`, `templates/:kind` and
 * `sources/:id/...` are distinct prefixes.
 */
@Controller("knowledge")
export class KnowledgeSourcesController {
  constructor(private readonly svc: KnowledgeSourcesService) {}

  @Get("sources")
  list(@CurrentWorkspace() ws: string, @Query() q: ListSourcesQuery) {
    return this.svc.list(ws, q);
  }

  @Get("sources/:id")
  get(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.svc.get(ws, id);
  }

  @Get("sources/:id/preview")
  preview(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.svc.preview(ws, id);
  }

  @Get("sources/:id/pages")
  pages(@CurrentWorkspace() ws: string, @Param("id") id: string, @Query() q: ListPagesQuery) {
    return this.svc.pages(ws, id, q);
  }

  @Get("sources/:id/file")
  file(@CurrentWorkspace() ws: string, @Param("id") id: string, @Res() res: Response) {
    return this.svc.sendFile(ws, id, res);
  }

  @Delete("sources/:id")
  remove(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.svc.remove(ws, id);
  }

  @Post("sources/:id/reprocess")
  reprocess(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.svc.reprocess(ws, id);
  }

  @Put("content")
  putContent(@CurrentWorkspace() ws: string, @CurrentUserId() userId: string, @Body() body: PutContentDto) {
    return this.svc.putContent(ws, userId, body);
  }

  @Put("guidelines")
  putGuidelines(@CurrentWorkspace() ws: string, @CurrentUserId() userId: string, @Body() body: PutGuidelinesDto) {
    return this.svc.putGuidelines(ws, userId, body);
  }

  @Post("faqs")
  createFaq(@CurrentWorkspace() ws: string, @CurrentUserId() userId: string, @Body() body: CreateFaqDto) {
    return this.svc.createFaq(ws, userId, body);
  }

  @Post("faqs/reorder")
  reorderFaqs(@CurrentWorkspace() ws: string, @Body() body: ReorderFaqsDto) {
    return this.svc.reorderFaqs(ws, body);
  }

  @Patch("faqs/:id")
  patchFaq(@CurrentWorkspace() ws: string, @Param("id") id: string, @Body() body: PatchFaqDto) {
    return this.svc.patchFaq(ws, id, body);
  }

  @Post("files")
  @UseInterceptors(
    FilesInterceptor("files", KB_BATCH_MAX + 1, {
      // In memory: every file of the batch is checked before anything is stored.
      // The service refuses > KB_FILE_MAX_BYTES with knowledge.file_too_large;
      // multer's own cap sits just above it.
      storage: memoryStorage(),
      limits: { fileSize: KB_FILE_MAX_BYTES + 1024 * 1024, files: KB_BATCH_MAX + 1 },
    }),
  )
  upload(
    @CurrentWorkspace() ws: string,
    @CurrentUserId() userId: string,
    @Body() body: UploadFilesDto,
    @UploadedFiles() files: Express.Multer.File[] = [],
  ) {
    return this.svc.uploadFiles(ws, userId, files ?? [], { typedKind: body?.typedKind, acceptValidRows: body?.acceptValidRows });
  }

  @Get("templates/:kind")
  async template(@Param("kind") kind: string, @Res() res: Response) {
    if (!isTypedKind(kind)) throw knowledgeError("knowledge.not_found");
    const buf = await buildTypedTemplate(kind);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${templateFileName(kind)}"`);
    res.send(buf);
  }
}
