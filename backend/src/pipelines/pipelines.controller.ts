import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { PipelinesService } from "./pipelines.service";
import { CreatePipelineDto, ListPipelinesQuery, SavePipelineDraftDto } from "./pipelines.dto";

/**
 * SP-07. The two GET /pipelines routes used to live in TicketsController; they
 * moved here (same paths) so every /pipelines route has one owner and there is
 * no ordering clash between "pipelines/:id" and the new "pipelines/:id/..." routes.
 */
@Controller("pipelines")
export class PipelinesController {
  constructor(private readonly svc: PipelinesService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string, @Query() q: ListPipelinesQuery) {
    return this.svc.list(workspaceId, q.includeArchived === "1" || q.includeArchived === "true");
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreatePipelineDto) {
    return this.svc.create(workspaceId, dto);
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.get(workspaceId, id);
  }

  @Get(":id/lost-reasons")
  lostReasons(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.lostReasons(workspaceId, id);
  }

  @Put(":id/draft")
  saveDraft(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: SavePipelineDraftDto,
  ) {
    return this.svc.saveDraft(workspaceId, id, dto);
  }

  @Post(":id/archive")
  archive(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.archive(workspaceId, id);
  }

  @Post(":id/unarchive")
  unarchive(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.unarchive(workspaceId, id);
  }
}
