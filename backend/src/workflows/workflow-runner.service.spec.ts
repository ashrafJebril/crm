import { WorkflowRunnerService } from "./workflow-runner.service";

describe("WorkflowRunnerService", () => {
  let prisma: { workflowRun: { findUniqueOrThrow: jest.Mock; update: jest.Mock } };
  let sendWhatsapp: { execute: jest.Mock };
  let askAgent: { execute: jest.Mock };
  let updateData: { execute: jest.Mock };
  let runner: WorkflowRunnerService;

  const baseRun = (over: Record<string, unknown> = {}) => ({
    id: "run1",
    workspaceId: "ws1",
    context: { trigger: { contact: { id: "c1", lifecycle: "lead" } }, steps: {} },
    cursor: { stepId: null },
    result: {},
    ...over,
  });

  beforeEach(() => {
    prisma = {
      workflowRun: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    sendWhatsapp = { execute: jest.fn().mockResolvedValue({ ok: true, id: "m1" }) };
    askAgent = { execute: jest.fn().mockResolvedValue({ answer: "yes" }) };
    updateData = { execute: jest.fn().mockResolvedValue({ tags: ["vip"] }) };
    runner = new WorkflowRunnerService(
      prisma as never,
      sendWhatsapp as never,
      askAgent as never,
      updateData as never,
    );
  });

  it("completes immediately for an empty graph", async () => {
    prisma.workflowRun.findUniqueOrThrow.mockResolvedValue(
      baseRun({ stepsSnapshot: { entry: null, steps: {} } }),
    );
    await runner.run("run1");
    expect(prisma.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "run1" },
      data: expect.objectContaining({ status: "completed" }),
    });
  });

  it("executes a single send_whatsapp step then completes", async () => {
    prisma.workflowRun.findUniqueOrThrow.mockResolvedValue(
      baseRun({
        cursor: { stepId: "s1" },
        stepsSnapshot: {
          entry: "s1",
          steps: { s1: { id: "s1", type: "send_whatsapp", config: { message: "hi" } } },
        },
      }),
    );
    await runner.run("run1");
    expect(sendWhatsapp.execute).toHaveBeenCalledWith("ws1", { message: "hi" }, expect.anything());
    const call = prisma.workflowRun.update.mock.calls[0][0];
    expect(call.data.status).toBe("completed");
    expect(call.data.result.s1).toEqual({ ok: true, id: "m1" });
  });

  it("stops at a delay step and stores a resumable cursor", async () => {
    prisma.workflowRun.findUniqueOrThrow.mockResolvedValue(
      baseRun({
        cursor: { stepId: "d1" },
        stepsSnapshot: {
          entry: "d1",
          steps: {
            d1: { id: "d1", type: "delay", config: { amount: 1, unit: "hours" }, next: "s1" },
            s1: { id: "s1", type: "send_whatsapp", config: { message: "hi" } },
          },
        },
      }),
    );
    await runner.run("run1");
    expect(sendWhatsapp.execute).not.toHaveBeenCalled();
    const call = prisma.workflowRun.update.mock.calls[0][0];
    expect(call.data.status).toBe("waiting");
    expect(call.data.cursor).toEqual({ stepId: "s1" });
    expect(call.data.resumeAt).toBeInstanceOf(Date);
  });

  it("resumes from a stored cursor and completes when nothing follows a terminal delay", async () => {
    prisma.workflowRun.findUniqueOrThrow.mockResolvedValue(
      baseRun({
        cursor: { stepId: null },
        stepsSnapshot: { entry: "d1", steps: { d1: { id: "d1", type: "delay", config: { amount: 1, unit: "hours" } } } },
      }),
    );
    await runner.run("run1");
    expect(prisma.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "run1" },
      data: expect.objectContaining({ status: "completed" }),
    });
  });

  it("follows thenNext when a condition passes", async () => {
    prisma.workflowRun.findUniqueOrThrow.mockResolvedValue(
      baseRun({
        cursor: { stepId: "c1" },
        stepsSnapshot: {
          entry: "c1",
          steps: {
            c1: {
              id: "c1",
              type: "condition",
              config: { field: "trigger.contact.lifecycle", operator: "equals", value: "lead" },
              thenNext: "then1",
              elseNext: "else1",
            },
            then1: { id: "then1", type: "send_whatsapp", config: { message: "then" } },
            else1: { id: "else1", type: "send_whatsapp", config: { message: "else" } },
          },
        },
      }),
    );
    await runner.run("run1");
    expect(sendWhatsapp.execute).toHaveBeenCalledWith("ws1", { message: "then" }, expect.anything());
  });

  it("follows elseNext when a condition fails, and ends if the branch has no next", async () => {
    prisma.workflowRun.findUniqueOrThrow.mockResolvedValue(
      baseRun({
        cursor: { stepId: "c1" },
        stepsSnapshot: {
          entry: "c1",
          steps: {
            c1: {
              id: "c1",
              type: "condition",
              config: { field: "trigger.contact.lifecycle", operator: "equals", value: "customer" },
              thenNext: "then1",
              elseNext: "else1",
            },
            then1: { id: "then1", type: "send_whatsapp", config: { message: "then" } },
            else1: { id: "else1", type: "send_whatsapp", config: { message: "else" } },
          },
        },
      }),
    );
    await runner.run("run1");
    expect(sendWhatsapp.execute).toHaveBeenCalledWith("ws1", { message: "else" }, expect.anything());
  });

  it("evaluates an ai_condition via the AskAgentExecutor", async () => {
    askAgent.execute.mockResolvedValue({ answer: "No, not eligible" });
    prisma.workflowRun.findUniqueOrThrow.mockResolvedValue(
      baseRun({
        cursor: { stepId: "ai1" },
        stepsSnapshot: {
          entry: "ai1",
          steps: {
            ai1: { id: "ai1", type: "ai_condition", config: { prompt: "eligible?" }, elseNext: "else1" },
            else1: { id: "else1", type: "send_whatsapp", config: { message: "else" } },
          },
        },
      }),
    );
    await runner.run("run1");
    expect(askAgent.execute).toHaveBeenCalledWith("ws1", { prompt: "eligible?" }, expect.anything());
    expect(sendWhatsapp.execute).toHaveBeenCalledWith("ws1", { message: "else" }, expect.anything());
  });

  it("flags aiUnavailable and still follows elseNext when the AI agent is unreachable (answer: null)", async () => {
    askAgent.execute.mockResolvedValue({ answer: null });
    prisma.workflowRun.findUniqueOrThrow.mockResolvedValue(
      baseRun({
        cursor: { stepId: "ai1" },
        stepsSnapshot: {
          entry: "ai1",
          steps: {
            ai1: { id: "ai1", type: "ai_condition", config: { prompt: "eligible?" }, elseNext: "else1" },
            else1: { id: "else1", type: "send_whatsapp", config: { message: "else" } },
          },
        },
      }),
    );
    await runner.run("run1");
    expect(sendWhatsapp.execute).toHaveBeenCalledWith("ws1", { message: "else" }, expect.anything());
    const call = prisma.workflowRun.update.mock.calls[0][0];
    expect(call.data.result.ai1).toEqual({ passed: false, aiUnavailable: true });
  });

  it("marks the run failed when a step executor throws, without throwing itself", async () => {
    sendWhatsapp.execute.mockRejectedValue(new Error("zernio down"));
    prisma.workflowRun.findUniqueOrThrow.mockResolvedValue(
      baseRun({
        cursor: { stepId: "s1" },
        stepsSnapshot: { entry: "s1", steps: { s1: { id: "s1", type: "send_whatsapp", config: { message: "hi" } } } },
      }),
    );
    await expect(runner.run("run1")).resolves.toBeUndefined();
    expect(prisma.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "run1" },
      data: expect.objectContaining({ status: "failed", error: "zernio down" }),
    });
  });

  it("makes a step's output available to later steps via {{steps.<id>...}}", async () => {
    prisma.workflowRun.findUniqueOrThrow.mockResolvedValue(
      baseRun({
        cursor: { stepId: "ask1" },
        stepsSnapshot: {
          entry: "ask1",
          steps: {
            ask1: { id: "ask1", type: "ask_agent", config: { prompt: "hi" }, next: "send1" },
            send1: { id: "send1", type: "send_whatsapp", config: { message: "Agent: {{steps.ask1.answer}}" } },
          },
        },
      }),
    );
    await runner.run("run1");
    expect(sendWhatsapp.execute).toHaveBeenLastCalledWith(
      "ws1",
      { message: "Agent: {{steps.ask1.answer}}" }, // config itself is unresolved — resolution happens inside the executor
      expect.objectContaining({ steps: { ask1: { answer: "yes" } } }),
    );
  });
});
