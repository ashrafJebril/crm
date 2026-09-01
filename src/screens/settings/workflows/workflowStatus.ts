import type { WorkflowActionStatus, WorkflowRunStatus } from "../../../api/aiWorkflows";

export type WorkflowBadgeKind = "ok" | "bad" | "info" | "warn" | "";

export const workflowStatusBadge = (status: WorkflowRunStatus | WorkflowActionStatus): WorkflowBadgeKind => {
  if (status === "COMPLETED" || status === "SENT") return "ok";
  if (["PARTIAL_FAILED", "FAILED", "FAILED_RETRYABLE", "FAILED_PERMANENT"].includes(status)) return "bad";
  if (["BLOCKED_KILL_SWITCH", "BLOCKED_BY_TEST_ALLOWLIST", "SKIPPED_NO_CUSTOMER_EMAIL", "SKIPPED_CUSTOMER_OPT_OUT"].includes(status)) return "warn";
  if (status === "PENDING" || status === "RUNNING") return "info";
  return "";
};

export const canRetryWorkflowRun = (status: WorkflowRunStatus): boolean =>
  (["PARTIAL_FAILED", "FAILED", "BLOCKED_KILL_SWITCH"] as WorkflowRunStatus[]).includes(status);
