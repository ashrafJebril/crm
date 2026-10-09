import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../auth/public.decorator";
import { WorkflowDispatchService } from "./workflow-dispatch.service";
import { WorkflowWebhookRow, WorkflowWebhookSignatureGuard } from "./workflow-webhook-signature.guard";

@Controller()
export class WorkflowsWebhookController {
  constructor(private readonly dispatch: WorkflowDispatchService) {}

  @Public()
  @UseGuards(WorkflowWebhookSignatureGuard)
  @HttpCode(200)
  @Post("webhooks/workflows/:workflowId")
  async receive(
    @Param("workflowId") _workflowId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request & { workflow?: WorkflowWebhookRow },
  ) {
    const workflow = req.workflow;
    if (!workflow || workflow.status !== "active") {
      return { ok: true, skipped: true };
    }
    await this.dispatch.startRun(workflow, body, false);
    return { ok: true };
  }
}
