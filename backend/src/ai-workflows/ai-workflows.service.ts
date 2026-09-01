import { Injectable } from "@nestjs/common";
import { AiWorkflowsClient, type WorkflowInput } from "./ai-workflows.client";

@Injectable()
export class AiWorkflowsService {
  constructor(private readonly client: AiWorkflowsClient) {}
  list(workspaceId: string) { return this.client.list(workspaceId); }
  create(workspaceId: string, input: WorkflowInput) { return this.client.create(workspaceId, input); }
  update(workspaceId: string, id: string, input: Partial<WorkflowInput>) { return this.client.update(workspaceId, id, input); }
  delete(workspaceId: string, id: string) { return this.client.delete(workspaceId, id); }
  preview(workspaceId: string, input: WorkflowInput) { return this.client.preview(workspaceId, input); }
  setKillSwitch(workspaceId: string, enabled: boolean) { return this.client.setKillSwitch(workspaceId, enabled); }
  listRuns(workspaceId: string) { return this.client.listRuns(workspaceId); }
  getRun(workspaceId: string, runId: string) { return this.client.getRun(workspaceId, runId); }
  retryRun(workspaceId: string, runId: string) { return this.client.retryRun(workspaceId, runId); }
}
