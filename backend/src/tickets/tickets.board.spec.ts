import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { TicketsService } from "./tickets.service";

function makeSvc() {
  const prisma: any = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    workspace: { findUnique: jest.fn().mockResolvedValue({ timezone: "Asia/Riyadh" }) },
    ticket: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockImplementation(async (a: any) => ({ id: a.where.id, ...a.data })),
      create: jest.fn().mockResolvedValue({ id: "tk_new", number: 1, stageId: "st_new" }),
    },
    ticketStage: { findFirst: jest.fn(), findMany: jest.fn() },
    pipeline: { findFirst: jest.fn().mockResolvedValue({ archivedAt: null, kind: "leads" }) },
    ticketActivity: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue(null) },
    contact: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    lostReason: { findFirst: jest.fn() },
  };
  prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
  const realtime = { emitToWorkspace: jest.fn() };
  const perm = { viewerCan: jest.fn().mockResolvedValue(true) };
  const svc = new TicketsService(prisma, realtime as never, undefined, undefined, perm as never);
  return { svc, prisma, realtime, perm };
}
type M = ReturnType<typeof makeSvc>;

const OPEN = { id: "st_open", pipelineId: "pl", key: "new", isTerminal: false, isWon: false, order: 0 };
const WON = { id: "st_won", pipelineId: "pl", key: "won", isTerminal: true, isWon: true, order: 8 };
const LOST = { id: "st_lost", pipelineId: "pl", key: "lost", isTerminal: true, isWon: false, order: 9 };

describe("listTickets table view", () => {
  it("returns {items,nextCursor,total}, sorted with an id tie-break", async () => {
    const { svc, prisma } = makeSvc();
    const rows = [1, 2, 3].map((n) => ({ id: `t${n}`, createdAt: new Date(2026, 0, n), updatedAt: new Date() }));
    prisma.ticket.findMany.mockResolvedValue(rows);
    prisma.ticket.count.mockResolvedValue(7);
    const r: any = await svc.listTickets("ws", { view: "table", sort: "createdAt", dir: "asc", limit: 2 });
    expect(prisma.ticket.findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(prisma.ticket.findMany.mock.calls[0][0].take).toBe(3);
    expect(r.items).toHaveLength(2);
    expect(r.total).toBe(7);
    expect(typeof r.nextCursor).toBe("string");
  });

  it("a short page has no cursor; the next page applies the keyset after the cursor", async () => {
    const { svc, prisma } = makeSvc();
    prisma.ticket.findMany.mockResolvedValue([{ id: "t1", createdAt: new Date("2026-01-01T00:00:00Z") }]);
    const first: any = await svc.listTickets("ws", { view: "table", sort: "createdAt", dir: "desc" });
    expect(first.nextCursor).toBeNull();
    const cursor = Buffer.from(JSON.stringify(["2026-01-01T00:00:00.000Z", "t9"])).toString("base64url");
    await svc.listTickets("ws", { view: "table", sort: "createdAt", dir: "desc", cursor });
    const where = prisma.ticket.findMany.mock.calls[1][0].where;
    expect(where.AND[1]).toEqual({
      OR: [
        { createdAt: { lt: new Date("2026-01-01T00:00:00Z") } },
        { createdAt: new Date("2026-01-01T00:00:00Z"), id: { lt: "t9" } },
      ],
    });
  });

  it("rejects an unknown sort field", async () => {
    const { svc } = makeSvc();
    await expect(svc.listTickets("ws", { view: "table", sort: "title" as never })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("filter parity: table and kanban apply the same filter where, total counts the same set", async () => {
    const { svc, prisma } = makeSvc();
    const f = { pipelineId: "pl", ownerId: "none", status: "open" as const, q: "ac", from: "2026-03-01", to: "2026-03-31" };
    await svc.listTickets("ws", f);
    await svc.listTickets("ws", { ...f, view: "table" });
    const kanbanWhere = prisma.ticket.findMany.mock.calls[0][0].where;
    expect(prisma.ticket.findMany.mock.calls[1][0].where).toEqual(kanbanWhere);
    expect(prisma.ticket.count).toHaveBeenCalledWith({ where: kanbanWhere });
    expect(kanbanWhere).toMatchObject({ ownerId: null, stage: { isTerminal: false } });
    expect(kanbanWhere.createdAt.gte).toEqual(new Date("2026-02-28T21:00:00.000Z"));
  });

  it("uses the workspace timezone for date bounds", async () => {
    const { svc, prisma } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue({ timezone: "UTC" });
    await svc.listTickets("ws", { from: "2026-03-01" });
    expect(prisma.ticket.findMany.mock.calls[0][0].where.createdAt.gte).toEqual(new Date("2026-03-01T00:00:00Z"));
  });

  it("without view=table the response shape is unchanged (no total)", async () => {
    const { svc } = makeSvc();
    expect(Object.keys(await svc.listTickets("ws", { stageId: "s" })).sort()).toEqual(["items", "nextCursor"]);
  });
});

describe("lead pipelines", () => {
  const create = { pipelineId: "pl", stageId: "st_open", contactId: "c1", title: "Lead" };
  function setupCreate(m: M) {
    m.prisma.ticketStage.findFirst.mockResolvedValue(OPEN);
    m.prisma.contact.findFirst.mockResolvedValue({ id: "c1" });
  }

  it("creating a second open lead for the same contact is 409 tickets.lead_exists with the existing id", async () => {
    const m = makeSvc();
    setupCreate(m);
    m.prisma.ticket.findFirst.mockImplementation(async (a: any) => (a.where.stage?.isTerminal === false ? { id: "tk_old" } : null));
    const err: any = await m.svc.createTicket("ws", create).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ statusCode: 409, message: "tickets.lead_exists", ticketId: "tk_old" });
    expect(m.prisma.ticket.create).not.toHaveBeenCalled();
  });

  it("the check and the insert run in one transaction behind a per-contact advisory lock", async () => {
    const m = makeSvc();
    setupCreate(m);
    await m.svc.createTicket("ws", create);
    expect(m.prisma.$transaction).toHaveBeenCalled();
    expect(m.prisma.$executeRaw).toHaveBeenCalled();
    expect(m.prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(m.prisma.ticket.create.mock.invocationCallOrder[0]);
  });

  it("the lead guard treats open as a non-terminal stage, not closedAt null", async () => {
    const m = makeSvc();
    setupCreate(m);
    await m.svc.createTicket("ws", create);
    expect(m.prisma.ticket.findFirst.mock.calls[0][0].where).toMatchObject({ stage: { isTerminal: false } });
    expect(m.prisma.ticket.findFirst.mock.calls[0][0].where).not.toHaveProperty("closedAt");
  });

  it("a ticket created directly in a terminal stage is closed", async () => {
    const m = makeSvc();
    m.prisma.ticketStage.findFirst.mockResolvedValue(WON);
    m.prisma.contact.findFirst.mockResolvedValue({ id: "c1" });
    await m.svc.createTicket("ws", { ...create, stageId: "st_won" });
    expect(m.prisma.ticket.create.mock.calls[0][0].data.closedAt).toBeInstanceOf(Date);
    const o = makeSvc();
    setupCreate(o);
    await o.svc.createTicket("ws", create);
    expect(o.prisma.ticket.create.mock.calls[0][0].data.closedAt).toBeNull();
  });

  it("deals pipelines are not constrained and use no transaction", async () => {
    const m = makeSvc();
    setupCreate(m);
    m.prisma.pipeline.findFirst.mockResolvedValue({ archivedAt: null, kind: "deals" });
    await m.svc.createTicket("ws", create);
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
    expect(m.prisma.ticket.create).toHaveBeenCalled();
  });

  describe("moving", () => {
    function setupMove(m: M, target: any, from: any = OPEN, lifecycle = "lead", kind = "leads") {
      m.prisma.ticket.findFirst.mockResolvedValue({
        id: "tk", workspaceId: "ws", pipelineId: "pl", stageId: from.id, stage: from, contactId: "c1",
        closedAt: from.isTerminal ? new Date() : null,
        pipeline: { agentCanMove: true, kind },
      });
      m.prisma.ticketStage.findFirst.mockResolvedValue(target);
      m.prisma.contact.findFirst.mockResolvedValue({ id: "c1", lifecycle });
    }

    it("lead won sets contact lifecycle customer", async () => {
      const m = makeSvc();
      setupMove(m, WON);
      await m.svc.moveTicket("ws", "tk", { stageId: "st_won" });
      expect(m.prisma.contact.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { lifecycle: "customer" } });
      expect(m.prisma.ticketActivity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: "lifecycle_changed", ticketId: "tk", note: "lifecycle:lead->customer" }),
      });
    });

    it("an already-customer contact is left alone (no marker)", async () => {
      const m = makeSvc();
      setupMove(m, WON, OPEN, "customer");
      await m.svc.moveTicket("ws", "tk", { stageId: "st_won" });
      expect(m.prisma.contact.update).not.toHaveBeenCalled();
    });

    it("lost leaves the lifecycle unchanged", async () => {
      const m = makeSvc();
      setupMove(m, LOST);
      await m.svc.moveTicket("ws", "tk", { stageId: "st_lost", lostReason: "no budget" });
      expect(m.prisma.contact.update).not.toHaveBeenCalled();
    });

    it("deals pipelines never touch the lifecycle", async () => {
      const m = makeSvc();
      setupMove(m, WON, OPEN, "lead", "deals");
      await m.svc.moveTicket("ws", "tk", { stageId: "st_won" });
      expect(m.prisma.contact.update).not.toHaveBeenCalled();
    });

    it("a failing contact write rolls the move back (one transaction: the move rolls back with it)", async () => {
      const m = makeSvc();
      setupMove(m, WON);
      m.prisma.contact.update.mockRejectedValue(new Error("db down"));
      // Emulate a real transaction: writes made through tx are discarded when the callback throws.
      const committed: string[] = [];
      m.prisma.$transaction = jest.fn(async (cb: any) => {
        const staged: string[] = [];
        const tx = {
          ...m.prisma,
          ticket: { ...m.prisma.ticket, update: jest.fn(async (a: any) => (staged.push("move"), { id: "tk", ...a.data })) },
          ticketActivity: { ...m.prisma.ticketActivity, create: jest.fn(async () => (staged.push("activity"), {})) },
        };
        const out = await cb(tx);
        committed.push(...staged);
        return out;
      });
      await expect(m.svc.moveTicket("ws", "tk", { stageId: "st_won" })).rejects.toThrow("db down");
      expect(m.prisma.$transaction).toHaveBeenCalled();
      expect(committed).toEqual([]);
      expect(m.realtime.emitToWorkspace).not.toHaveBeenCalled();
    });

    it("dragging a closed lead back to an open stage is guarded by uniqueness too", async () => {
      const m = makeSvc();
      setupMove(m, OPEN, LOST);
      const closedRow = {
        id: "tk", stage: LOST, stageId: "st_lost", pipelineId: "pl", contactId: "c1", closedAt: new Date(),
        pipeline: { agentCanMove: true, kind: "leads" },
      };
      m.prisma.ticket.findFirst.mockImplementation(async (a: any) => (a.where.stage?.isTerminal === false ? { id: "tk_other" } : closedRow));
      await expect(m.svc.moveTicket("ws", "tk", { stageId: "st_open" })).rejects.toBeInstanceOf(ConflictException);
    });
  });
});

describe("reopenTicket", () => {
  function setup(m: M, opts: { otherWon?: boolean; kind?: string; lifecycle?: string; marker?: string | null; closed?: any } = {}) {
    const closed = opts.closed ?? LOST;
    m.prisma.ticket.findFirst = jest.fn(async (a: any) => {
      if (a.where.stage?.isTerminal === false) return null; // no other open lead
      if (a.where.pipeline) return opts.otherWon ? { id: "tk_won2" } : null; // other won lead card
      return {
        id: "tk", workspaceId: "ws", pipelineId: "pl", stageId: closed.id, stage: closed, contactId: "c1", closedAt: new Date(),
        lostReason: "x", lostReasonId: "r1", pipeline: { agentCanMove: true, kind: opts.kind ?? "leads", archivedAt: null },
      };
    });
    m.prisma.ticketActivity.findFirst.mockImplementation(async (a: any) => {
      if (a.where.kind === "lifecycle_changed") return opts.marker ? { note: opts.marker } : null;
      return { kind: closed.isWon ? "won" : "lost", fromStage: "qualified" };
    });
    m.prisma.ticketStage.findFirst.mockImplementation(async (a: any) =>
      a.where.key === "qualified" ? { id: "st_q", pipelineId: "pl", key: "qualified", isTerminal: false, isWon: false } : null,
    );
    m.prisma.contact.findFirst.mockResolvedValue({ id: "c1", lifecycle: opts.lifecycle ?? "lead" });
  }

  it("reopen restores previous stage, clears closedAt/lostReason, logs an activity", async () => {
    const m = makeSvc();
    setup(m);
    await m.svc.reopenTicket("ws", "tk", undefined, "u1");
    expect(m.prisma.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tk" },
        data: expect.objectContaining({ stageId: "st_q", closedAt: null, lostReason: null, lostReasonId: null }),
      }),
    );
    expect(m.prisma.ticketActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "reopened", ticketId: "tk", fromStage: "lost", toStage: "qualified", byUserId: "u1" }),
    });
  });

  it("falls back to the first open stage when the old stage is gone", async () => {
    const m = makeSvc();
    setup(m);
    m.prisma.ticketStage.findFirst.mockImplementation(async (a: any) =>
      a.where.key ? null : { id: "st_first", pipelineId: "pl", key: "new", isTerminal: false },
    );
    await m.svc.reopenTicket("ws", "tk");
    expect(m.prisma.ticket.update.mock.calls[0][0].data.stageId).toBe("st_first");
  });

  it("an open ticket cannot be reopened", async () => {
    const m = makeSvc();
    m.prisma.ticket.findFirst.mockResolvedValue({ id: "tk", stage: OPEN, closedAt: null, pipeline: { kind: "leads", agentCanMove: true } });
    await expect(m.svc.reopenTicket("ws", "tk")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("unknown ticket is 404", async () => {
    const m = makeSvc();
    await expect(m.svc.reopenTicket("ws", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("agentCanMove=false needs pipelines.update", async () => {
    const m = makeSvc();
    m.prisma.ticket.findFirst = jest.fn().mockResolvedValue({
      id: "tk", stage: LOST, closedAt: new Date(), pipelineId: "pl", contactId: "c1", pipeline: { agentCanMove: false, kind: "leads" },
    });
    m.perm.viewerCan.mockResolvedValue(false);
    await expect(m.svc.reopenTicket("ws", "tk", { userId: "u" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.prisma.ticket.update).not.toHaveBeenCalled();
  });

  it("reopening a lead whose contact already has another open card is 409", async () => {
    const m = makeSvc();
    setup(m);
    m.prisma.ticket.findFirst = jest.fn(async (a: any) =>
      a.where.stage?.isTerminal === false
        ? { id: "tk_other" }
        : { id: "tk", stage: LOST, closedAt: new Date(), pipelineId: "pl", contactId: "c1", pipeline: { agentCanMove: true, kind: "leads" } },
    );
    await expect(m.svc.reopenTicket("ws", "tk")).rejects.toBeInstanceOf(ConflictException);
    expect(m.prisma.ticket.update).not.toHaveBeenCalled();
  });

  it("reopening a won lead restores lifecycle lead when this card set it and it is still customer", async () => {
    const m = makeSvc();
    setup(m, { closed: WON, lifecycle: "customer", marker: "lifecycle:lead->customer" });
    await m.svc.reopenTicket("ws", "tk");
    expect(m.prisma.contact.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { lifecycle: "lead" } });
  });

  it("keeps customer when the contact has another won lead card elsewhere", async () => {
    const m = makeSvc();
    setup(m, { closed: WON, lifecycle: "customer", marker: "lifecycle:lead->customer", otherWon: true });
    await m.svc.reopenTicket("ws", "tk");
    expect(m.prisma.contact.update).not.toHaveBeenCalled();
  });

  it("does not touch the lifecycle without the marker, or if the contact moved on", async () => {
    const a = makeSvc();
    setup(a, { closed: WON, lifecycle: "customer", marker: null });
    await a.svc.reopenTicket("ws", "tk");
    expect(a.prisma.contact.update).not.toHaveBeenCalled();
    const b = makeSvc();
    setup(b, { closed: WON, lifecycle: "vip", marker: "lifecycle:lead->customer" });
    await b.svc.reopenTicket("ws", "tk");
    expect(b.prisma.contact.update).not.toHaveBeenCalled();
  });

  it("reopening a lost lead leaves the lifecycle alone", async () => {
    const m = makeSvc();
    setup(m, { closed: LOST, lifecycle: "customer", marker: "lifecycle:lead->customer" });
    await m.svc.reopenTicket("ws", "tk");
    expect(m.prisma.contact.update).not.toHaveBeenCalled();
  });
});
