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
