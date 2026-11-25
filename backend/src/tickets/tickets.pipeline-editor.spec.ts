import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { TicketsService } from "./tickets.service";

function setup(opts: { agentCanMove?: boolean; archivedAt?: Date | null; canUpdate?: boolean } = {}) {
  const ticket = {
    id: "tk_1", pipelineId: "pl_1", stageId: "st_work", workspaceId: "ws_1",
    stage: { id: "st_work", key: "work" },
    pipeline: { id: "pl_1", agentCanMove: opts.agentCanMove ?? true, archivedAt: null },
  };
  const stages: Record<string, any> = {
    st_lost: { id: "st_lost", key: "lost", pipelineId: "pl_1", isTerminal: true, isWon: false },
    st_next: { id: "st_next", key: "next", pipelineId: "pl_1", isTerminal: false, isWon: false },
  };
  const prisma: any = {
    ticket: {
      findFirst: jest.fn().mockResolvedValue(ticket),
      update: jest.fn(async (a: any) => ({ id: "tk_1", ...a.data })),
    },
    ticketStage: {
      findFirst: jest.fn(async (a: any) => ({ ...stages[a.where.id], pipeline: { archivedAt: opts.archivedAt ?? null } })),
    },
    pipeline: { findFirst: jest.fn().mockResolvedValue({ id: "pl_1", archivedAt: opts.archivedAt ?? null }) },
    lostReason: {
      findFirst: jest.fn(async (a: any) =>
        a.where.id === "lr_ok" && a.where.pipelineId === "pl_1" ? { id: "lr_ok", label: "Price too high" } : null,
      ),
    },
    contact: { findFirst: jest.fn().mockResolvedValue({ id: "c1" }) },
    ticketActivity: { create: jest.fn().mockResolvedValue({}) },
  };
  const perm = { viewerCan: jest.fn().mockResolvedValue(opts.canUpdate ?? false) };
  const svc = new TicketsService(
    prisma,
    { emitToWorkspace: jest.fn() } as any,
    undefined,
    undefined,
    perm as any,
  );
  return { svc, prisma, perm };
}

describe("move gate (agentCanMove)", () => {
  it("agentCanMove=true: anyone with tickets.update may move; no extra permission lookup", async () => {
    const { svc, perm } = setup({ agentCanMove: true });
    await svc.moveTicket("ws_1", "tk_1", { stageId: "st_next" }, { userId: "u1" } as any);
    expect(perm.viewerCan).not.toHaveBeenCalled();
  });

  it("agentCanMove=false: a viewer without pipelines.update is 403", async () => {
    const { svc, perm, prisma } = setup({ agentCanMove: false, canUpdate: false });
    await expect(svc.moveTicket("ws_1", "tk_1", { stageId: "st_next" }, { userId: "u1" } as any)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(perm.viewerCan).toHaveBeenCalledWith("ws_1", { userId: "u1" }, "pipelines.update");
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  it("agentCanMove=false: a viewer with pipelines.update (owner/admin) may move", async () => {
    const { svc } = setup({ agentCanMove: false, canUpdate: true });
    await expect(svc.moveTicket("ws_1", "tk_1", { stageId: "st_next" }, { userId: "u1" } as any)).resolves.toBeDefined();
  });

  it("internal callers (no viewer: automation, resolution) are not gated", async () => {
    const { svc } = setup({ agentCanMove: false, canUpdate: false });
    await expect(svc.moveTicket("ws_1", "tk_1", { stageId: "st_next" })).resolves.toBeDefined();
  });
});

describe("mark lost with lostReasonId", () => {
  it("validates the reason against the ticket's pipeline and stores the label as the lostReason snapshot", async () => {
    const { svc, prisma } = setup();
    await svc.moveTicket("ws_1", "tk_1", { stageId: "st_lost", lostReasonId: "lr_ok" });
    expect(prisma.lostReason.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "lr_ok", pipelineId: "pl_1", workspaceId: "ws_1", archivedAt: null }) }),
    );
    expect(prisma.ticket.update.mock.calls[0][0].data).toMatchObject({ lostReasonId: "lr_ok", lostReason: "Price too high" });
    expect(prisma.ticketActivity.create.mock.calls[0][0].data).toMatchObject({ kind: "lost", note: "Price too high" });
  });

  it("a reason from another pipeline (or archived) is 400 pipelines.invalid_lost_reason", async () => {
    const { svc } = setup();
    const err = await svc.moveTicket("ws_1", "tk_1", { stageId: "st_lost", lostReasonId: "lr_other" }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe("pipelines.invalid_lost_reason");
  });

  it("the legacy free-text lostReason still works and leaves lostReasonId null", async () => {
    const { svc, prisma } = setup();
    await svc.moveTicket("ws_1", "tk_1", { stageId: "st_lost", lostReason: "Other" });
    expect(prisma.ticket.update.mock.calls[0][0].data).toMatchObject({ lostReason: "Other", lostReasonId: null });
  });

  it("moving to a non-lost stage clears the reason", async () => {
    const { svc, prisma } = setup();
    await svc.moveTicket("ws_1", "tk_1", { stageId: "st_next" });
    expect(prisma.ticket.update.mock.calls[0][0].data).toMatchObject({ lostReason: null, lostReasonId: null });
  });

  it("a lost move with neither reason is still 400", async () => {
    const { svc } = setup();
    await expect(svc.moveTicket("ws_1", "tk_1", { stageId: "st_lost" })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("archived pipelines", () => {
  it("new tickets cannot be created in an archived pipeline (400 pipelines.archived)", async () => {
    const { svc, prisma } = setup({ archivedAt: new Date() });
    const err = await svc
      .createTicket("ws_1", { pipelineId: "pl_1", stageId: "st_next", contactId: "c1", title: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe("pipelines.archived");
    expect(prisma.ticket.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({ orderBy: expect.anything() }));
  });
});

describe("assignsConversations", () => {
  function build(assigns: boolean) {
    const base = setup();
    const { prisma } = base;
    prisma.ticket.findFirst = jest.fn().mockResolvedValue({
      id: "tk_1", pipelineId: "pl_1", workspaceId: "ws_1", ownerId: null, conversationId: "cv_1", value: null,
    });
    prisma.workspaceMember = { findFirst: jest.fn().mockResolvedValue({ id: "m" }) };
    prisma.pipeline.findFirst = jest.fn().mockResolvedValue({ id: "pl_1", assignsConversations: assigns });
    prisma.conversation = {
      findFirst: jest.fn().mockResolvedValue({ id: "cv_1", channel: "whatsapp", contactId: "c1", assigneeId: null, updatedAt: new Date(0) }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    prisma.user = { findUnique: jest.fn().mockResolvedValue({ name: "Boss" }) };
    const realtime = { emitToWorkspace: jest.fn() };
    const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
    const svc = new TicketsService(prisma, realtime as any, undefined, notifications as any, undefined);
    return { svc, prisma, realtime, notifications };
  }

  it("owner change on a flagged pipeline moves the conversation (version bump, inbox.activity, notification)", async () => {
    const { svc, prisma, realtime, notifications } = build(true);
    await svc.updateTicket("ws_1", "tk_1", { ownerId: "u2" } as any, "u1");
    expect(prisma.conversation.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "cv_1", workspaceId: "ws_1" },
      data: { assigneeId: "u2", version: { increment: 1 } },
    });
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws_1", "inbox.activity", expect.objectContaining({ conversationId: "cv_1" }));
    expect(notifications.notify).toHaveBeenCalledWith("ws_1", ["u2"], expect.objectContaining({ title: "assignment.conversation", recordId: "cv_1" }));
  });

  it("does nothing when the flag is off", async () => {
    const { svc, prisma } = build(false);
    await svc.updateTicket("ws_1", "tk_1", { ownerId: "u2" } as any, "u1");
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("skips an opaque (non-DB) conversation id without failing", async () => {
    const { svc, prisma } = build(true);
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(svc.updateTicket("ws_1", "tk_1", { ownerId: "u2" } as any, "u1")).resolves.toBeDefined();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("createTicket with owner and conversation assigns it too", async () => {
    const { svc, prisma } = build(true);
    prisma.ticketStage.findFirst = jest.fn().mockResolvedValue({ id: "st_1", pipelineId: "pl_1", key: "new" });
    prisma.pipeline.findFirst = jest.fn().mockResolvedValue({ archivedAt: null, kind: "deals", assignsConversations: true });
    prisma.conversation.findFirst = jest.fn()
      .mockResolvedValueOnce({ id: "cv_1" })
      .mockResolvedValue({ id: "cv_1", channel: "whatsapp", contactId: "c1", assigneeId: null, updatedAt: new Date(0) });
    prisma.ticket.findFirst = jest.fn().mockResolvedValue({ number: 1 });
    prisma.ticket.create = jest.fn().mockResolvedValue({ id: "tk_9", title: "t" });
    await svc.createTicket("ws_1", { pipelineId: "pl_1", stageId: "st_1", contactId: "c1", conversationId: "cv_1", ownerId: "u2", title: "t" } as any, "u1");
    expect(prisma.conversation.updateMany).toHaveBeenCalledTimes(1);
  });
});
