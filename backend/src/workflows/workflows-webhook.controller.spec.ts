import { WorkflowsWebhookController } from "./workflows-webhook.controller";

describe("WorkflowsWebhookController payment lock", () => {
  const wf = { id: "wf1", workspaceId: "ws1", status: "active", steps: {} };
  const call = (dispatch: unknown) =>
    new WorkflowsWebhookController(dispatch as never).receive("wf1", { a: 1 }, { workflow: wf } as never);

  it("answers 200 and skips when the dispatcher drops the run (locked)", async () => {
    const dispatch = { startTriggeredRun: jest.fn().mockResolvedValue(null) };
    await expect(call(dispatch)).resolves.toEqual({ ok: true, skipped: true });
    expect(dispatch.startTriggeredRun).toHaveBeenCalledWith(wf, { a: 1 });
  });

  it("answers ok when a run starts", async () => {
    const dispatch = { startTriggeredRun: jest.fn().mockResolvedValue({ id: "r" }) };
    await expect(call(dispatch)).resolves.toEqual({ ok: true });
  });
});
