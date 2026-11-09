import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { TicketsService } from "./tickets.service";
import { UNDO_NOTE, stripReservedMarker } from "./undo-stage";

const NOW = new Date("2026-11-11T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

function setup(o: {
  latest?: any;
  stageKey?: string;
  canManage?: boolean;
  moveError?: Error;
  ticket?: any;
  fromStage?: any;
} = {}) {
  const ticket =
    o.ticket === undefined
      ? { id: "tk_1", pipelineId: "pl_1", workspaceId: "ws", stageId: "st_b", stage: { id: "st_b", key: o.stageKey ?? "b" } }
      : o.ticket;
  const latest =
    o.latest === undefined
      ? { kind: "stage_changed", fromStage: "a", toStage: "b", byUserId: "u1", note: null, createdAt: ago(2) }
      : o.latest;
  const prisma: any = {
    ticket: { findFirst: jest.fn().mockResolvedValue(ticket) },
    ticketActivity: { findFirst: jest.fn().mockResolvedValue(latest) },
    ticketStage: { findFirst: jest.fn().mockResolvedValue(o.fromStage ?? { id: "st_a", key: "a", pipelineId: "pl_1", isTerminal: false, isWon: false }) },
  };
  const perm = { viewerCan: jest.fn().mockResolvedValue(o.canManage ?? false) };
  const svc = new TicketsService(prisma, { emitToWorkspace: jest.fn() } as any, undefined, undefined, perm as any);
  const move = jest
    .spyOn(svc, "moveTicket")
    .mockImplementation(async () => {
      if (o.moveError) throw o.moveError;
      return { id: "tk_1", stageId: "st_a" } as any;
    });
  return { svc, prisma, perm, move };
}

const viewer = { userId: "u1" };

describe("TicketsService.undoLastMove", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it("moves the ticket back to fromStage as the viewer, marked as an undo", async () => {
    const { svc, move, prisma } = setup();
    const res = await svc.undoLastMove("ws", "tk_1", viewer);
    expect(res).toMatchObject({ id: "tk_1" });
    expect(move).toHaveBeenCalledWith("ws", "tk_1", { stageId: "st_a", note: UNDO_NOTE, byUserId: "u1" }, viewer, {
      expectStageId: "st_b",
    });
    expect((prisma.ticketStage.findFirst.mock.calls[0] as any)[0].where).toMatchObject({ key: "a", pipelineId: "pl_1", workspaceId: "ws" });
    expect((prisma.ticketActivity.findFirst.mock.calls[0] as any)[0].where).toMatchObject({
      ticketId: "tk_1",
      workspaceId: "ws",
      kind: { in: ["stage_changed", "won", "lost"] },
    });
  });

  it("404s an unknown ticket", async () => {
    const { svc, move } = setup({ ticket: null });
    await expect(svc.undoLastMove("ws", "x", viewer)).rejects.toBeInstanceOf(NotFoundException);
    expect(move).not.toHaveBeenCalled();
  });

  it("409 tickets.undo_expired after 10 minutes", async () => {
    const { svc, move } = setup({
      latest: { kind: "stage_changed", fromStage: "a", toStage: "b", byUserId: "u1", note: null, createdAt: ago(11) },
    });
    await expect(svc.undoLastMove("ws", "tk_1", viewer)).rejects.toMatchObject({ message: "tickets.undo_expired" });
    await expect(svc.undoLastMove("ws", "tk_1", viewer)).rejects.toBeInstanceOf(ConflictException);
    expect(move).not.toHaveBeenCalled();
  });

  it("is still allowed at exactly the 10 minute edge", async () => {
    const { svc, move } = setup({
      latest: { kind: "stage_changed", fromStage: "a", toStage: "b", byUserId: "u1", note: null, createdAt: ago(10) },
    });
    await svc.undoLastMove("ws", "tk_1", viewer);
    expect(move).toHaveBeenCalled();
  });

  it("409 tickets.undo_not_latest when the ticket has left that stage", async () => {
    const { svc, move } = setup({ stageKey: "c" });
    await expect(svc.undoLastMove("ws", "tk_1", viewer)).rejects.toMatchObject({ message: "tickets.undo_not_latest" });
    expect(move).not.toHaveBeenCalled();
  });

  it("409 tickets.undo_not_latest when the latest move is a won/lost close or there is none", async () => {
    for (const latest of [
      { kind: "won", fromStage: "a", toStage: "b", byUserId: "u1", note: null, createdAt: ago(1) },
      { kind: "lost", fromStage: "a", toStage: "b", byUserId: "u1", note: "x", createdAt: ago(1) },
      null,
    ]) {
      const { svc } = setup({ latest });
      await expect(svc.undoLastMove("ws", "tk_1", viewer)).rejects.toMatchObject({ message: "tickets.undo_not_latest" });
    }
  });

  it("409 tickets.undo_not_allowed when the move came out of a Lost stage", async () => {
    const { svc, move } = setup({ fromStage: { id: "st_a", key: "a", pipelineId: "pl_1", isTerminal: true, isWon: false } });
    await expect(svc.undoLastMove("ws", "tk_1", viewer)).rejects.toMatchObject({ message: "tickets.undo_not_allowed" });
    expect(move).not.toHaveBeenCalled();
    // a Won terminal stage is not blocked
    await setup({ fromStage: { id: "st_a", key: "a", pipelineId: "pl_1", isTerminal: true, isWon: true } }).svc.undoLastMove("ws", "tk_1", viewer);
  });

  it("the reserved undo marker cannot be typed by users, and legacy undo rows stay non-undoable", async () => {
    expect(stripReservedMarker(UNDO_NOTE)).toBe("undo");
    const { svc } = setup({
      latest: { kind: "stage_changed", fromStage: "b", toStage: "b", byUserId: "u1", note: "undo", createdAt: ago(1) },
    });
    await expect(svc.undoLastMove("ws", "tk_1", viewer)).rejects.toMatchObject({ message: "tickets.undo_not_latest" });
  });

  it("an undo move is not itself undoable", async () => {
    const { svc } = setup({
      latest: { kind: "stage_changed", fromStage: "b", toStage: "b", byUserId: "u1", note: UNDO_NOTE, createdAt: ago(1) },
    });
    await expect(svc.undoLastMove("ws", "tk_1", viewer)).rejects.toMatchObject({ message: "tickets.undo_not_latest" });
  });

  it("only the author may undo, unless the viewer holds tickets.manage", async () => {
    const other = setup();
    await expect(other.svc.undoLastMove("ws", "tk_1", { userId: "u2" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(other.move).not.toHaveBeenCalled();

    const manager = setup({ canManage: true });
    await manager.svc.undoLastMove("ws", "tk_1", { userId: "u2" });
    expect(manager.perm.viewerCan).toHaveBeenCalledWith("ws", { userId: "u2" }, "tickets.manage");
    expect(manager.move).toHaveBeenCalledWith("ws", "tk_1", expect.objectContaining({ byUserId: "u2" }), { userId: "u2" }, { expectStageId: "st_b" });
  });

  it("a move with no recorded author is undoable only by a manager", async () => {
    const latest = { kind: "stage_changed", fromStage: "a", toStage: "b", byUserId: null, note: null, createdAt: ago(1) };
    await expect(setup({ latest }).svc.undoLastMove("ws", "tk_1", viewer)).rejects.toBeInstanceOf(ForbiddenException);
    await setup({ latest, canManage: true }).svc.undoLastMove("ws", "tk_1", viewer);
  });

  it("surfaces the agentCanMove refusal from moveTicket", async () => {
    const err = new ForbiddenException({ statusCode: 403, message: "Missing permission", permission: "pipelines.update" });
    const { svc } = setup({ moveError: err });
    await expect(svc.undoLastMove("ws", "tk_1", viewer)).rejects.toBe(err);
  });
});

describe("TicketsService.moveTicket expectStageId (undo race)", () => {
  function race(count: number, stageId = "st_b") {
    const ticket = { id: "tk_1", pipelineId: "pl_1", stageId, workspaceId: "ws", contactId: "c", stage: { id: stageId, key: "b" }, pipeline: { agentCanMove: true, kind: "deals" } };
    const prisma: any = {
      ticket: {
        findFirst: jest.fn().mockResolvedValue(ticket),
        updateMany: jest.fn().mockResolvedValue({ count }),
        update: jest.fn(),
      },
      ticketStage: { findFirst: jest.fn().mockResolvedValue({ id: "st_a", key: "a", pipelineId: "pl_1", isTerminal: false, isWon: false }) },
      ticketActivity: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    return { prisma, svc: new TicketsService(prisma, { emitToWorkspace: jest.fn() } as any) };
  }

  it("moves with a conditional update and logs the activity when the ticket is still in the expected stage", async () => {
    const { svc, prisma } = race(1);
    await svc.moveTicket("ws", "tk_1", { stageId: "st_a", note: UNDO_NOTE }, undefined, { expectStageId: "st_b" });
    expect((prisma.ticket.updateMany.mock.calls[0] as any)[0].where).toMatchObject({ id: "tk_1", stageId: "st_b" });
    expect(prisma.ticketActivity.create).toHaveBeenCalled();
  });

  it("409 tickets.undo_not_latest, no activity, when a concurrent move won (conditional update matched nothing)", async () => {
    const { svc, prisma } = race(0);
    await expect(
      svc.moveTicket("ws", "tk_1", { stageId: "st_a" }, undefined, { expectStageId: "st_b" }),
    ).rejects.toMatchObject({ message: "tickets.undo_not_latest" });
    expect(prisma.ticketActivity.create).not.toHaveBeenCalled();
  });

  it("409 up front when the ticket already left the expected stage", async () => {
    const { svc, prisma } = race(1, "st_c");
    await expect(
      svc.moveTicket("ws", "tk_1", { stageId: "st_a" }, undefined, { expectStageId: "st_b" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.ticket.updateMany).not.toHaveBeenCalled();
  });
});
