import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import * as crypto from "node:crypto";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";

export interface WorkflowWebhookRow {
  id: string;
  workspaceId: string;
  status: string;
  steps: unknown;
  webhookSecret: string | null;
}

/**
 * Verifies `X-Workflow-Signature` (hex HMAC-SHA256 of the raw body, keyed by
 * the workflow's own webhookSecret) before the webhook handler runs. Written
 * fresh rather than copied from ZernioWebhookSignatureGuard, which currently
 * carries an unresolved, in-progress diagnostic-logging block — that block
 * must not be propagated into new code. Requires `rawBody: true` on the Nest
 * app (already set in main.ts).
 */
@Injectable()
export class WorkflowWebhookSignatureGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer; workflow?: WorkflowWebhookRow; params: { workflowId: string } }>();

    const workflow = await this.prisma.workflow.findUnique({ where: { id: req.params.workflowId } });
    if (!workflow?.webhookSecret) {
      throw new ForbiddenException("Workflow webhook not configured");
    }

    const header = (req.header("x-workflow-signature") ?? "").replace(/^sha256=/, "");
    if (!req.rawBody || !header) {
      throw new ForbiddenException("Missing workflow webhook signature");
    }

    const expected = crypto.createHmac("sha256", workflow.webhookSecret).update(req.rawBody).digest("hex");
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new ForbiddenException("Invalid workflow webhook signature");
    }

    req.workflow = workflow as unknown as WorkflowWebhookRow;
    return true;
  }
}
