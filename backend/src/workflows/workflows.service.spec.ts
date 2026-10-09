// backend/src/workflows/workflows.service.spec.ts
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { WorkflowsService } from "./workflows.service";

describe("WorkflowsService", () => {
  let prisma: {
    workflow: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
    workflowRun: { findMany: jest.Mock; findFirst: jest.Mock };
  };
  let dispatch: { startRun: jest.Mock };
  let svc: WorkflowsService;

  const row = (over: Record<string, unknown> = {}) => ({
    id: "wf1",
    workspaceId: "ws1",
    name: "Welcome new leads",
    status: "draft",
    triggerType: "contact_created",
    triggerConfig: {},
    steps: { entry: null, steps: {} },
    webhookSecret: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    prisma = {
      workflow: {
        findMany: jest.fn().mockResolvedValue([row()]),
        findFirst: jest.fn().mockResolvedValue(row()),
        create: jest.fn().mockResolvedValue(row()),
        update: jest.fn().mockResolvedValue(row({ status: "active" })),
        delete: jest.fn().mockResolvedValue(row()),
      },
      workflowRun: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    dispatch = { startRun: jest.fn().mockResolvedValue({ id: "run1" }) };
    svc = new WorkflowsService(prisma as never, dispatch as never);
  });

  it("lists workflows for the workspace", async () => {
    const rows = await svc.list("ws1");
    expect(prisma.workflow.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws1" },
      orderBy: { createdAt: "desc" },
    });
    expect(rows[0].id).toBe("wf1");
  });

  it("throws NotFoundException for a workflow outside the workspace", async () => {
    prisma.workflow.findFirst.mockResolvedValue(null);
    await expect(svc.get("ws1", "missing")).rejects.toThrow(NotFoundException);
  });

  it("creates a workflow with a generated webhookSecret only for webhook triggers", async () => {
    await svc.create("ws1", { name: "n", triggerType: "webhook" });
    expect(prisma.workflow.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ webhookSecret: expect.any(String) }),
    });
  });

  it("does not set a webhookSecret for a non-webhook trigger", async () => {
    await svc.create("ws1", { name: "n", triggerType: "contact_created" });
    expect(prisma.workflow.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ webhookSecret: null }),
    });
  });

  it("rejects a create with a malformed step graph", async () => {
    await expect(svc.create("ws1", { name: "n", triggerType: "contact_created", steps: "nope" })).rejects.toThrow(BadRequestException);
  });

  it("rejects an update with a malformed step graph", async () => {
    await expect(svc.update("ws1", "wf1", { steps: "nope" })).rejects.toThrow(BadRequestException);
  });

  const incompleteGraph = {
    entry: "s1",
    steps: { s1: { id: "s1", type: "send_whatsapp", config: { message: "" } } },
  };

  it("allows creating a draft with an empty-but-correctly-typed string field", async () => {
    await expect(svc.create("ws1", { name: "n", triggerType: "contact_created", steps: incompleteGraph })).resolves.toBeDefined();
  });

  it("allows updating a draft with an empty-but-correctly-typed string field", async () => {
    await expect(svc.update("ws1", "wf1", { steps: incompleteGraph })).resolves.toBeDefined();
  });

  it("rejects activating a workflow with an empty-but-correctly-typed string field", async () => {
    prisma.workflow.findFirst.mockResolvedValue(row({ steps: incompleteGraph }));
    await expect(svc.activate("ws1", "wf1")).rejects.toThrow(BadRequestException);
  });

  it("rejects activating a workflow with no steps", async () => {
    prisma.workflow.findFirst.mockResolvedValue(row({ steps: { entry: null, steps: {} } }));
    await expect(svc.activate("ws1", "wf1")).rejects.toThrow(BadRequestException);
  });

  it("activates a workflow that has steps", async () => {
    prisma.workflow.findFirst.mockResolvedValue(
      row({ steps: { entry: "s1", steps: { s1: { id: "s1", type: "delay", config: { amount: 1, unit: "hours" } } } } }),
    );
    const result = await svc.activate("ws1", "wf1");
    expect(prisma.workflow.update).toHaveBeenCalledWith({ where: { id: "wf1" }, data: { status: "active" } });
    expect(result.status).toBe("active");
  });

  it("mints a webhookSecret when update() switches triggerType into webhook", async () => {
    prisma.workflow.findFirst.mockResolvedValue(row({ triggerType: "contact_created", webhookSecret: null }));
    await svc.update("ws1", "wf1", { triggerType: "webhook" });
    expect(prisma.workflow.update).toHaveBeenCalledWith({
      where: { id: "wf1" },
      data: expect.objectContaining({ triggerType: "webhook", webhookSecret: expect.any(String) }),
    });
  });

  it("clears webhookSecret when update() switches triggerType away from webhook", async () => {
    prisma.workflow.findFirst.mockResolvedValue(row({ triggerType: "webhook", webhookSecret: "abc123" }));
    await svc.update("ws1", "wf1", { triggerType: "contact_created" });
    expect(prisma.workflow.update).toHaveBeenCalledWith({
      where: { id: "wf1" },
      data: expect.objectContaining({ triggerType: "contact_created", webhookSecret: null }),
    });
  });

  it("leaves webhookSecret untouched when triggerType is not changed", async () => {
    prisma.workflow.findFirst.mockResolvedValue(row({ triggerType: "webhook", webhookSecret: "abc123" }));
    await svc.update("ws1", "wf1", { name: "renamed" });
    expect(prisma.workflow.update).toHaveBeenCalledWith({
      where: { id: "wf1" },
      data: expect.objectContaining({ webhookSecret: undefined }),
    });
  });

  it("test() starts a run via WorkflowDispatchService and returns its id, bypassing status", async () => {
    const fixture = row();
    prisma.workflow.findFirst.mockResolvedValue(fixture);
    const result = await svc.test("ws1", "wf1", { payload: { contact: { id: "c1" } } });
    expect(dispatch.startRun).toHaveBeenCalledWith(fixture, { contact: { id: "c1" } }, true);
    expect(result).toEqual({ runId: "run1" });
  });
});
