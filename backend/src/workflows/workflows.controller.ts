import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { CreateWorkflowDto, TestWorkflowDto, UpdateWorkflowDto } from "./workflows.dto";
import { WorkflowsService } from "./workflows.service";

@Controller("workflows")
export class WorkflowsController {
  constructor(private readonly svc: WorkflowsService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.get(workspaceId, id);
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateWorkflowDto) {
    return this.svc.create(workspaceId, dto);
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateWorkflowDto,
  ) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.remove(workspaceId, id);
  }

  @Post(":id/activate")
  activate(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.activate(workspaceId, id);
  }

  @Post(":id/deactivate")
  deactivate(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.deactivate(workspaceId, id);
  }

  @Post(":id/test")
  test(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: TestWorkflowDto,
  ) {
    return this.svc.test(workspaceId, id, dto);
  }

  @Get(":id/runs")
  listRuns(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.listRuns(workspaceId, id);
  }

  @Get(":id/runs/:runId")
  getRun(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Param("runId") runId: string,
  ) {
    return this.svc.getRun(workspaceId, id, runId);
  }
}
