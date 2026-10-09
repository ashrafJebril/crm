export const WORKFLOW_TRIGGER_EVENT = "workflow.trigger";

export interface WorkflowTriggerEvent {
  workspaceId: string;
  triggerType: string;
  payload: Record<string, unknown>;
}
