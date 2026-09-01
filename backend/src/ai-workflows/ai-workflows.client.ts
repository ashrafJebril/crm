import { HttpException, Injectable, Logger } from "@nestjs/common";

export type WorkflowTrigger = "BOOKING_CREATED" | "BOOKING_RESCHEDULED" | "BOOKING_CANCELLED";
export type WorkflowCondition =
  | { field: "branch.id" | "booking.source"; op: "EQ"; value: string }
  | { field: "services.ids"; op: "CONTAINS_ANY"; value: string[] };
export type WorkflowAction =
  | { type: "CUSTOMER_EMAIL"; subject: string; body: string }
  | { type: "STAFF_EMAIL"; recipients: string[]; subject: string; body: string };
export interface WorkflowInput {
  name: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
}

@Injectable()
export class AiWorkflowsClient {
  private readonly log = new Logger(AiWorkflowsClient.name);
  private static readonly TIMEOUT_MS = 15_000;

  list(tenantId: string) {
    return this.request("GET", this.tenantPath(tenantId, "/workflows"));
  }
  create(tenantId: string, input: WorkflowInput) {
    return this.request("POST", this.tenantPath(tenantId, "/workflows"), input);
  }
  update(tenantId: string, id: string, input: Partial<WorkflowInput>) {
    return this.request("PATCH", this.tenantPath(tenantId, `/workflows/${encodeURIComponent(id)}`), input);
  }
  delete(tenantId: string, id: string) {
    return this.request("DELETE", this.tenantPath(tenantId, `/workflows/${encodeURIComponent(id)}`));
  }
  preview(tenantId: string, input: WorkflowInput) {
    return this.request("POST", this.tenantPath(tenantId, "/workflows/preview"), input);
  }
  setKillSwitch(tenantId: string, enabled: boolean) {
    return this.request("POST", this.tenantPath(tenantId, "/workflow-kill-switch"), { enabled });
  }
  listRuns(tenantId: string) {
    return this.request("GET", this.tenantPath(tenantId, "/workflow-runs"));
  }
  getRun(tenantId: string, runId: string) {
    return this.request("GET", this.tenantPath(tenantId, `/workflow-runs/${encodeURIComponent(runId)}`));
  }
  retryRun(tenantId: string, runId: string) {
    return this.request("POST", this.tenantPath(tenantId, `/workflow-runs/${encodeURIComponent(runId)}/retry`), {});
  }

  private tenantPath(tenantId: string, suffix: string) {
    return `/admin/tenants/${encodeURIComponent(tenantId)}${suffix}`;
  }

  private config() {
    const url = process.env.KEWY_AI_URL;
    const secret = process.env.KEWY_AI_ADMIN_SECRET;
    if (!url || !secret) return null;
    return { baseUrl: `${url.replace(/\/+$/, "")}/api/v1`, secret };
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const cfg = this.config();
    if (!cfg) {
      throw new HttpException(
        { code: "AI_WORKFLOWS_NOT_CONFIGURED", message: "AI workflows are not configured for this deployment." },
        503,
      );
    }
    let response: Response;
    try {
      response = await fetch(`${cfg.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-kewy-admin-secret": cfg.secret },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(AiWorkflowsClient.TIMEOUT_MS),
      });
    } catch (error) {
      const timeout = (error as Error).name === "TimeoutError";
      this.log.warn(`kewy-ai workflows ${method} ${path} unavailable: ${(error as Error).message}`);
      throw new HttpException(
        {
          code: timeout ? "AI_WORKFLOWS_TIMEOUT" : "AI_WORKFLOWS_UNAVAILABLE",
          message: timeout
            ? "The workflow service took too long to respond. Reload to check whether the change was saved."
            : "The workflow service is temporarily unavailable. Try again shortly.",
        },
        503,
      );
    }

    const raw = response.status === 204 ? "" : await response.text();
    let data: any;
    try { data = raw ? JSON.parse(raw) : undefined; } catch { data = raw; }
    if (!response.ok) {
      const message = data && typeof data === "object" && typeof data.message === "string" ? data.message : "";
      this.log.warn(`kewy-ai workflows ${method} ${path} -> ${response.status} ${message.slice(0, 160)}`);
      if (response.status >= 400 && response.status < 500 && ![401, 403].includes(response.status)) {
        throw new HttpException(
          { code: "AI_WORKFLOW_REJECTED", message: message || "The workflow configuration was rejected." },
          response.status === 404 ? 404 : 400,
        );
      }
      throw new HttpException(
        { code: "AI_WORKFLOW_UPSTREAM_ERROR", message: "The workflow service failed to handle the request. Try again shortly." },
        502,
      );
    }
    return data;
  }
}
