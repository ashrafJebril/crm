import { api } from "./client";

export const WORKFLOW_TRIGGERS = ["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];
export const TEMPLATE_VARIABLES = [
  "customer.name", "customer.email", "customer.phone", "booking.id", "booking.status",
  "booking.date", "booking.time", "booking.previousDate", "booking.previousTime",
  "branch.name", "branch.timezone", "services.names", "services.count",
] as const;

export type WorkflowCondition =
  | { field: "branch.id" | "booking.source"; op: "EQ"; value: string }
  | { field: "services.ids"; op: "CONTAINS_ANY"; value: string[] };
export type WorkflowAction =
  | { type: "CUSTOMER_EMAIL"; subject: string; body: string }
  | { type: "STAFF_EMAIL"; recipients: string[]; subject: string; body: string };
export interface WorkflowDraft {
  name: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
}
export interface Workflow extends WorkflowDraft {
  id: string;
  updatedAt?: string;
  lastRun?: { status: string; createdAt: string } | null;
}
export interface WorkflowRunAction {
  id?: string;
  type?: string;
  status: string;
  recipient?: string | null;
  providerMessageId?: string | null;
  error?: string | null;
}
export interface WorkflowRun {
  id: string;
  workflowName?: string;
  status: string;
  event?: string;
  bookingId?: string;
  createdAt: string;
  actions?: WorkflowRunAction[];
  error?: string | null;
}
export interface WorkflowListResponse { workflows: Workflow[]; killSwitch?: boolean; workflowKillSwitch?: boolean; }
export interface WorkflowRunsResponse { runs: WorkflowRun[]; }

export const listWorkflows = () => api.get<WorkflowListResponse>("/ai/workflows");
export const createWorkflow = (draft: WorkflowDraft) => api.post<Workflow>("/ai/workflows", draft);
export const updateWorkflow = (id: string, patch: Partial<WorkflowDraft>) => api.patch<Workflow>(`/ai/workflows/${encodeURIComponent(id)}`, patch);
export const deleteWorkflow = (id: string) => api.delete<{ ok: true }>(`/ai/workflows/${encodeURIComponent(id)}`);
export const previewWorkflow = (draft: WorkflowDraft) => api.post<{ subject?: string; body?: string; actions?: Array<{ subject: string; body: string }> }>("/ai/workflows/preview", draft);
export const setWorkflowKillSwitch = (enabled: boolean) => api.post<{ enabled: boolean }>("/ai/workflows/kill-switch", { enabled });
export const retryWorkflowRun = (runId: string) => api.post<WorkflowRun>(`/ai/workflows/runs/${encodeURIComponent(runId)}/retry`, {});
