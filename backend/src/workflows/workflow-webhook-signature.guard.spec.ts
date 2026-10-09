import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import * as crypto from "node:crypto";
import { WorkflowWebhookSignatureGuard } from "./workflow-webhook-signature.guard";

function contextFor(req: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as never;
}

describe("WorkflowWebhookSignatureGuard", () => {
  let prisma: { workflow: { findUnique: jest.Mock } };
  let guard: WorkflowWebhookSignatureGuard;

  const secret = "topsecret";
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const validSig = crypto.createHmac("sha256", secret).update(body).digest("hex");

  beforeEach(() => {
    prisma = { workflow: { findUnique: jest.fn().mockResolvedValue({ id: "wf1", webhookSecret: secret }) } };
    guard = new WorkflowWebhookSignatureGuard(prisma as never);
  });

  it("allows a request with a valid signature and attaches the workflow row", async () => {
    const req = {
      params: { workflowId: "wf1" },
      rawBody: body,
      header: (name: string) => (name.toLowerCase() === "x-workflow-signature" ? validSig : undefined),
    };
    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect((req as { workflow?: unknown }).workflow).toEqual({ id: "wf1", webhookSecret: secret });
  });

  it("rejects an invalid signature", async () => {
    const req = { params: { workflowId: "wf1" }, rawBody: body, header: () => "0".repeat(validSig.length) };
    await expect(guard.canActivate(contextFor(req))).rejects.toThrow(ForbiddenException);
  });

  it("rejects a missing signature header", async () => {
    const req = { params: { workflowId: "wf1" }, rawBody: body, header: () => undefined };
    await expect(guard.canActivate(contextFor(req))).rejects.toThrow(ForbiddenException);
  });

  it("rejects when the workflow has no webhookSecret configured", async () => {
    prisma.workflow.findUnique.mockResolvedValue({ id: "wf1", webhookSecret: null });
    const req = { params: { workflowId: "wf1" }, rawBody: body, header: () => validSig };
    await expect(guard.canActivate(contextFor(req))).rejects.toThrow(ForbiddenException);
  });

  it("rejects when the workflow doesn't exist", async () => {
    prisma.workflow.findUnique.mockResolvedValue(null);
    const req = { params: { workflowId: "missing" }, rawBody: body, header: () => validSig };
    await expect(guard.canActivate(contextFor(req))).rejects.toThrow(ForbiddenException);
  });
});
