import { Body, Controller, Delete, Get, Module, Param, Post } from "@nestjs/common";
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { KnowledgeClient, KEWY_KNOWLEDGE_KINDS, type KewyKnowledgeKind } from "./knowledge.client";
import { KnowledgeService } from "./knowledge.service";

/** Trim at the DTO boundary so a body of only spaces fails @MinLength here
 *  rather than upstream, where the error arrives as a generic 400. */
const Trim = Transform(({ value }) => (typeof value === "string" ? value.trim() : value));

/**
 * Deliberately has NO tenantId field.
 *
 * The global ValidationPipe runs `forbidNonWhitelisted: true`, so a client that
 * posts one gets a 400 naming it rather than having it quietly stripped — a
 * loud failure is the right answer to an attempt to name another salon.
 */
class SaveDocDto {
  /** Present = update, absent = create. Upstream scopes the lookup by tenant,
   *  so an id belonging to another salon 400s there rather than editing it. */
  @IsOptional() @IsString() @MaxLength(64) id?: string;

  @Trim @IsString() @MinLength(1) @MaxLength(200) title!: string;

  // 100k is kewy-ai's cap, and it is a cost ceiling as much as a size one:
  // every chunk of this text is a paid embedding call on save.
  @Trim @IsString() @MinLength(1) @MaxLength(100_000) body!: string;

  @IsIn(KEWY_KNOWLEDGE_KINDS as unknown as string[]) kind!: KewyKnowledgeKind;
}

/**
 * Owner-facing proxy to kewy-ai's knowledge admin API.
 *
 * Mounted at `ai/knowledge` (so `/api/ai/knowledge/...`) behind the CRM's
 * normal AuthGuard — pointedly NOT `@Public()`. Everything about this module
 * exists to keep two things true:
 *
 *   1. the admin secret stays server-side (see KnowledgeClient), and
 *   2. the tenant comes from the JWT, never the request.
 */
@Controller("ai/knowledge")
export class KnowledgeController {
  constructor(
    private readonly svc: KnowledgeService,
    private readonly client: KnowledgeClient,
  ) {}

  /** Lets the tab render "not set up" instead of a red error on a deployment
   *  that never bought the AI module. Reports only whether config EXISTS. */
  @Get("status")
  status() {
    return { configured: this.client.isConfigured() };
  }

  @Get("docs")
  listDocs(@CurrentWorkspace() workspaceId: string) {
    return this.svc.listDocs(workspaceId);
  }

  @Post("docs")
  saveDoc(@CurrentWorkspace() workspaceId: string, @Body() dto: SaveDocDto) {
    return this.svc.saveDoc(workspaceId, {
      id: dto.id,
      title: dto.title,
      body: dto.body,
      kind: dto.kind,
    });
  }

  @Delete("docs/:id")
  deleteDoc(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.deleteDoc(workspaceId, id);
  }

  /** Re-pull services/branches/staff from hjz. Runs inline upstream and can
   *  take tens of seconds — the UI shows a spinner and waits. */
  @Post("sync")
  sync(@CurrentWorkspace() workspaceId: string) {
    return this.svc.sync(workspaceId);
  }
}

@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeClient],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
