import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { IsIn, IsObject, IsOptional, IsString } from "class-validator";
import { CurrentUserId, CurrentWorkspace } from "../common/current-workspace.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { LKnowledgeService } from "./l-knowledge.service";
import { LMcpService, type CreateLMcpServerInput } from "./l-mcp.service";
import { LToolsService, type CreateLToolInput } from "./l-tools.service";

class CreateToolDto implements CreateLToolInput {
  @IsString() name!: string;
  @IsString() description!: string;
  @IsIn(["GET", "POST", "PUT", "PATCH", "DELETE"]) method!: string;
  @IsString() url_template!: string;
  @IsOptional() @IsObject() headers?: Record<string, string>;
  @IsOptional() @IsObject() body_template?: Record<string, unknown> | null;
  @IsOptional() @IsObject() param_descriptions?: Record<string, string>;
}

class CreateMcpServerDto implements CreateLMcpServerInput {
  @IsString() name!: string;
  @IsString() description!: string;
  @IsString() url!: string;
  @IsOptional() @IsObject() headers?: Record<string, string>;
}

@Controller("integrations/l")
export class LConfigController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly knowledge: LKnowledgeService,
    private readonly tools: LToolsService,
    private readonly mcp: LMcpService,
  ) {}

  private async requireEditor(userId: string, workspaceId: string): Promise<void> {
    const role = await this.workspaces.requireMember(userId, workspaceId);
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenException("Only owner or admin can manage the Kewy AI agent");
    }
  }

  @Get("status")
  async status(@CurrentWorkspace() workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lWorkspaceId: true },
    });
    return { connected: Boolean(ws?.lWorkspaceId) };
  }

  @Get("knowledge")
  listKnowledge(@CurrentWorkspace() workspaceId: string) {
    return this.knowledge.list(workspaceId);
  }

  @Post("knowledge")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      // 25MB matches the cap the l platform itself already enforces for
      // document uploads — no point buffering more into this process's heap
      // than the upstream would accept anyway.
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  async uploadKnowledge(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    await this.requireEditor(userId, workspaceId);
    if (!file) throw new BadRequestException("No file provided");
    return this.knowledge.upload(workspaceId, file);
  }

  @Delete("knowledge/:documentId")
  async deleteKnowledge(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("documentId") documentId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.knowledge.remove(workspaceId, documentId);
    return { ok: true };
  }

  @Get("tools")
  listTools(@CurrentWorkspace() workspaceId: string) {
    return this.tools.list(workspaceId);
  }

  @Post("tools")
  async createTool(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Body() dto: CreateToolDto,
  ) {
    await this.requireEditor(userId, workspaceId);
    return this.tools.create(workspaceId, dto);
  }

  @Delete("tools/:toolId")
  async deleteTool(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("toolId") toolId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.tools.remove(workspaceId, toolId);
    return { ok: true };
  }

  // POST, not PUT: the frontend's shared `api` client (src/api/client.ts)
  // only exposes get/post/patch/delete, and adding a fifth verb there for
  // one call site isn't worth it — this endpoint is idempotent either way.
  @Post("tools/:toolId/binding")
  async bindTool(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("toolId") toolId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.tools.bind(workspaceId, toolId);
    return { ok: true };
  }

  @Delete("tools/:toolId/binding")
  async unbindTool(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("toolId") toolId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.tools.unbind(workspaceId, toolId);
    return { ok: true };
  }

  @Get("mcp-servers")
  listMcpServers(@CurrentWorkspace() workspaceId: string) {
    return this.mcp.list(workspaceId);
  }

  @Post("mcp-servers")
  async createMcpServer(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Body() dto: CreateMcpServerDto,
  ) {
    await this.requireEditor(userId, workspaceId);
    return this.mcp.create(workspaceId, dto);
  }

  @Delete("mcp-servers/:serverId")
  async deleteMcpServer(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("serverId") serverId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.mcp.remove(workspaceId, serverId);
    return { ok: true };
  }

  // POST, not PUT — same reason as bindTool above.
  @Post("mcp-servers/:serverId/binding")
  async bindMcpServer(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("serverId") serverId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.mcp.bind(workspaceId, serverId);
    return { ok: true };
  }

  @Delete("mcp-servers/:serverId/binding")
  async unbindMcpServer(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("serverId") serverId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.mcp.unbind(workspaceId, serverId);
    return { ok: true };
  }

  @Post("mcp-servers/:serverId/test")
  async testMcpServer(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("serverId") serverId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    return this.mcp.test(workspaceId, serverId);
  }
}
