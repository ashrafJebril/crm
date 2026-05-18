import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";
import { KnowledgeService } from "./knowledge.service";
import type { KnowledgeDocumentDto } from "./knowledge.dto";

type AuthedRequest = Request & { user: JwtPayload };

@Controller("knowledge")
export class KnowledgeController {
  constructor(private readonly svc: KnowledgeService) {}

  @Get("documents")
  list(@Req() req: AuthedRequest): Promise<KnowledgeDocumentDto[]> {
    const wsId = req.user.workspaceId;
    if (!wsId) throw new BadRequestException("No active workspace");
    return this.svc.list(wsId);
  }

  @Post("documents")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024 } }))
  upload(
    @Req() req: AuthedRequest,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<KnowledgeDocumentDto> {
    const wsId = req.user.workspaceId;
    if (!wsId) throw new BadRequestException("No active workspace");
    return this.svc.upload(wsId, req.user.sub, file);
  }

  @Delete("documents/:id")
  remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const wsId = req.user.workspaceId;
    if (!wsId) throw new BadRequestException("No active workspace");
    return this.svc.remove(wsId, id);
  }
}
