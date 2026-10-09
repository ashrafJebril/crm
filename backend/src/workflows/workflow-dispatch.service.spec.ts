import { WorkflowDispatchService } from "./workflow-dispatch.service";

describe("WorkflowDispatchService", () => {
  let prisma: {
    workflow: { findMany: jest.Mock };
    workflowRun: { create: jest.Mock };
  };
  let runner: { run: jest.Mock };
  let svc: WorkflowDispatchService;

  const workflow = (over: Record<string, unknown> = {}) => ({
    id: "wf1",
    workspaceId: "ws1",
    triggerType: "contact_created",
    triggerConfig: {},
    steps: { entry: "s1", steps: { s1: { id: "s1", type: "delay", config: { amount: 1, unit: "hours" } } } },
    ...over,
  });

  beforeEach(() => {
    prisma = {
      workflow: { findMany: jest.fn().mockResolvedValue([workflow()]) },
      workflowRun: { create: jest.fn().mockResolvedValue({ id: "run1" }) },
    };
    runner = { run: jest.fn().mockResolvedValue(undefined) };
    svc = new WorkflowDispatchService(prisma as never, runner as never);
  });

  it("creates and runs a WorkflowRun for each matching active workflow", async () => {
    await svc.handleTrigger({
      workspaceId: "ws1",
      triggerType: "contact_created",
      payload: { contact: { id: "c1" } },
    });
    expect(prisma.workflow.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws1", triggerType: "contact_created", status: "active" },
    });
    expect(prisma.workflowRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowId: "wf1",
        workspaceId: "ws1",
        status: "running",
        context: { trigger: { contact: { id: "c1" } }, steps: {} },
        cursor: { stepId: "s1" },
        isTest: false,
      }),
    });
    expect(runner.run).toHaveBeenCalledWith("run1");
  });

  it("skips a ticket_stage_changed workflow whose triggerConfig.stageId doesn't match", async () => {
    prisma.workflow.findMany.mockResolvedValue([
      workflow({ triggerType: "ticket_stage_changed", triggerConfig: { stageId: "st-won" } }),
    ]);
    await svc.handleTrigger({
      workspaceId: "ws1",
      triggerType: "ticket_stage_changed",
      payload: { ticket: { id: "t1", stageId: "st-lost" } },
    });
    expect(prisma.workflowRun.create).not.toHaveBeenCalled();
  });

  it("runs a ticket_stage_changed workflow whose triggerConfig.stageId matches", async () => {
    prisma.workflow.findMany.mockResolvedValue([
      workflow({ triggerType: "ticket_stage_changed", triggerConfig: { stageId: "st-won" } }),
    ]);
    await svc.handleTrigger({
      workspaceId: "ws1",
      triggerType: "ticket_stage_changed",
      payload: { ticket: { id: "t1", stageId: "st-won" } },
    });
    expect(prisma.workflowRun.create).toHaveBeenCalled();
  });

  it("never throws, even if prisma fails", async () => {
    prisma.workflow.findMany.mockRejectedValue(new Error("db down"));
    await expect(
      svc.handleTrigger({ workspaceId: "ws1", triggerType: "contact_created", payload: {} }),
    ).resolves.toBeUndefined();
  });

  it("startRun creates a run regardless of workflow status and marks it a test when asked", async () => {
    const run = await svc.startRun(workflow(), { contact: { id: "c9" } }, true);
    expect(prisma.workflowRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ isTest: true }),
    });
    expect(run).toEqual({ id: "run1" });
  });
});
