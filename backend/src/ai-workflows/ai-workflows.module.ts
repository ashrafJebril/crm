import { Module } from "@nestjs/common";
import { AiWorkflowsClient } from "./ai-workflows.client";
import { AiWorkflowsController } from "./ai-workflows.controller";
import { AiWorkflowsService } from "./ai-workflows.service";
import { WorkspaceRolesGuard } from "../common/workspace-roles.guard";

@Module({
  controllers: [AiWorkflowsController],
  providers: [AiWorkflowsClient, AiWorkflowsService, WorkspaceRolesGuard],
})
export class AiWorkflowsModule {}
