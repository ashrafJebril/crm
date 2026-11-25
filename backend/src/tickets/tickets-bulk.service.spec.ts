import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { TicketsBulkService, NOT_A_LEAD_REASON } from "./tickets-bulk.service";

const row = (id: string, over: any = {}) => ({
  id,
  pipelineId: "pl",
  contactId: `c_${id}`,
  closedAt: null,
  stage: { isTerminal: false, isWon: false },
  pipeline: { id: "pl", kind: "leads", agentCanMove: true, archivedAt: null },
  ...over,
});

function setup(rows: any[], perms: Record<string, boolean> = {}) {
  const prisma: any = {
    ticket: { findMany: jest.fn().mockResolvedValue(rows) },
    ticketStage: { findFirst: jest.fn().mockResolvedValue({ id: "st_lost" }) },
    lostReason: { findFirst: jest.fn().mockResolvedValue({ id: "r1", pipelineId: "pl", label: "No budget" }) },
    workspaceMember: { findFirst: jest.fn().mockResolvedValue({ id: "m" }) },
    contact: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const tickets = {
    moveTicket: jest.fn().mockResolvedValue({}),
    updateTicket: jest.fn().mockResolvedValue({}),
  };
  const perm = { viewerCan: jest.fn(async (_w: string, _v: any, p: string) => perms[p] ?? true) };
  const svc = new TicketsBulkService(prisma, tickets as never, perm as never);
  return { svc, prisma, tickets, perm };
}
const viewer = { userId: "u1" };

describe("TicketsBulkService", () => {
  it("validates ids: required, capped at 500, deduped", async () => {
    const s = setup([]);
    await expect(s.svc.run("ws", { ids: [], op: "assign", ownerId: null }, viewer)).rejects.toBeInstanceOf(BadRequestException);
    const many = Array.from({ length: 501 }, (_, i) => `t${i}`);
    await expect(s.svc.run("ws", { ids: many, op: "assign", ownerId: null }, viewer)).rejects.toBeInstanceOf(BadRequestException);
    const d = setup([row("a")]);
    await d.svc.run("ws", { ids: ["a", "a"], op: "assign", ownerId: null }, viewer);
    expect(d.prisma.ticket.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "ws", id: { in: ["a"] } } }));
  });

  it("an unknown op is 400", async () => {
    await expect(setup([row("a")]).svc.run("ws", { ids: ["a"], op: "explode" as never }, viewer)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("ids from another workspace -> 404 and nothing is applied", async () => {
    const s = setup([row("a")]);
    await expect(s.svc.run("ws", { ids: ["a", "foreign"], op: "assign", ownerId: "u2" }, viewer)).rejects.toBeInstanceOf(NotFoundException);
    expect(s.tickets.updateTicket).not.toHaveBeenCalled();
  });

  describe("assign", () => {
    it("assigns every row and reports affected", async () => {
      const s = setup([row("a"), row("b")]);
      const r = await s.svc.run("ws", { ids: ["a", "b"], op: "assign", ownerId: "u2" }, viewer, "u1");
      expect(r).toEqual({ affected: 2, skipped: [] });
      expect(s.tickets.updateTicket).toHaveBeenCalledWith("ws", "a", { ownerId: "u2" }, "u1");
    });

    it("null unassigns; undefined is 400; a non-member owner is 400", async () => {
      const s = setup([row("a")]);
      await s.svc.run("ws", { ids: ["a"], op: "assign", ownerId: null }, viewer);
      expect(s.tickets.updateTicket).toHaveBeenCalledWith("ws", "a", { ownerId: null }, undefined);
      await expect(s.svc.run("ws", { ids: ["a"], op: "assign" }, viewer)).rejects.toBeInstanceOf(BadRequestException);
      s.prisma.workspaceMember.findFirst.mockResolvedValue(null);
      await expect(s.svc.run("ws", { ids: ["a"], op: "assign", ownerId: "ghost" }, viewer)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("lost", () => {
    it("moves each open row to its pipeline's lost stage with the reason", async () => {
      const s = setup([row("a")]);
      const r = await s.svc.run("ws", { ids: ["a"], op: "lost", lostReasonId: "r1" }, viewer, "u1");
      expect(r).toEqual({ affected: 1, skipped: [] });
      expect(s.tickets.moveTicket).toHaveBeenCalledWith("ws", "a", { stageId: "st_lost", lostReasonId: "r1", byUserId: "u1" }, viewer);
    });

    it("requires a lostReasonId; a reason from another workspace is 404", async () => {
      const s = setup([row("a")]);
      await expect(s.svc.run("ws", { ids: ["a"], op: "lost" }, viewer)).rejects.toBeInstanceOf(BadRequestException);
      s.prisma.lostReason.findFirst.mockResolvedValue(null);
      await expect(s.svc.run("ws", { ids: ["a"], op: "lost", lostReasonId: "x" }, viewer)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("skips closed rows, rows of other pipelines than the reason's, and archived pipelines", async () => {
      const s = setup([
        row("open"),
        row("closed", { closedAt: new Date(), stage: { isTerminal: true, isWon: true } }),
        row("other", { pipelineId: "pl2", pipeline: { id: "pl2", kind: "deals", agentCanMove: true, archivedAt: null } }),
        row("arch", { pipeline: { id: "pl", kind: "leads", agentCanMove: true, archivedAt: new Date() } }),
      ]);
      const r = await s.svc.run("ws", { ids: ["open", "closed", "other", "arch"], op: "lost", lostReasonId: "r1" }, viewer);
      expect(r.affected).toBe(1);
      expect(r.skipped.sort()).toEqual(["arch", "closed", "other"]);
    });

    it("mixed-permission bulk: rows the actor cannot move are skipped, the rest applied", async () => {
      const s = setup([row("ok"), row("gated", { pipelineId: "pl", pipeline: { id: "pl", kind: "leads", agentCanMove: false, archivedAt: null } })]);
      s.tickets.moveTicket.mockImplementation(async (_w: string, id: string) => {
        if (id === "gated") throw new ForbiddenException({ permission: "pipelines.update" });
        return {};
      });
      const r = await s.svc.run("ws", { ids: ["ok", "gated"], op: "lost", lostReasonId: "r1" }, viewer);
      expect(r).toEqual({ affected: 1, skipped: ["gated"] });
    });

    it("a pipeline without a lost stage skips the row", async () => {
      const s = setup([row("a")]);
      s.prisma.ticketStage.findFirst.mockResolvedValue(null);
      expect(await s.svc.run("ws", { ids: ["a"], op: "lost", lostReasonId: "r1" }, viewer)).toEqual({ affected: 0, skipped: ["a"] });
    });

    it("unexpected errors are not swallowed", async () => {
      const s = setup([row("a")]);
      s.tickets.moveTicket.mockRejectedValue(new Error("db down"));
      await expect(s.svc.run("ws", { ids: ["a"], op: "lost", lostReasonId: "r1" }, viewer)).rejects.toThrow("db down");
    });
  });

  describe("notALead", () => {
    it("not-a-lead flags the contact and closes the card as lost with the bilingual snapshot", async () => {
      const s = setup([row("a")]);
      const r = await s.svc.run("ws", { ids: ["a"], op: "notALead" }, viewer, "u1");
      expect(r).toEqual({ affected: 1, skipped: [] });
      expect(s.tickets.moveTicket).toHaveBeenCalledWith(
        "ws",
        "a",
        { stageId: "st_lost", lostReason: NOT_A_LEAD_REASON, byUserId: "u1" },
        viewer,
        { inTx: expect.any(Function) },
      );
      // The flag is written through the move's own transaction client, not this.prisma.
      const tx = { contact: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
      await s.tickets.moveTicket.mock.calls[0][4].inTx(tx);
      expect(tx.contact.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: "ws", id: { in: ["c_a"] } },
        data: { notALead: true },
      });
      expect(s.prisma.contact.updateMany).not.toHaveBeenCalled();
      expect(NOT_A_LEAD_REASON).toMatch(/Not a lead/);
      expect(NOT_A_LEAD_REASON).toMatch(/[؀-ۿ]/);
    });

    it("needs contacts.update in addition to tickets.update (403)", async () => {
      const s = setup([row("a")], { "contacts.update": false });
      await expect(s.svc.run("ws", { ids: ["a"], op: "notALead" }, viewer)).rejects.toBeInstanceOf(ForbiddenException);
      expect(s.tickets.moveTicket).not.toHaveBeenCalled();
      expect(s.prisma.contact.updateMany).not.toHaveBeenCalled();
    });

    it("only open cards in leads pipelines; a gated or failed move does not flag the contact", async () => {
      const s = setup([
        row("deal", { pipeline: { id: "pl", kind: "deals", agentCanMove: true, archivedAt: null } }),
        row("closed", { closedAt: new Date(), stage: { isTerminal: true, isWon: false } }),
        row("gated"),
      ]);
      s.tickets.moveTicket.mockRejectedValue(new ForbiddenException());
      const r = await s.svc.run("ws", { ids: ["deal", "closed", "gated"], op: "notALead" }, viewer);
      expect(r.affected).toBe(0);
      expect(r.skipped.sort()).toEqual(["closed", "deal", "gated"]);
      expect(s.prisma.contact.updateMany).not.toHaveBeenCalled();
    });
  });
});
