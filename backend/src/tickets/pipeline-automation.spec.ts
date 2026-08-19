import { PipelineAutomationService } from "./pipeline-automation.service";

/**
 * Auto-pipeline for inbound messages (2026-08-19): an inbound message creates
 * a ticket in the 'new' group stage unless the contact already has an open
 * ticket in that pipeline; the first outbound human reply moves new →
 * contacted, strictly one-way. Automation must NEVER throw into the message
 * pipeline — failures log and swallow.
 */
describe("PipelineAutomationService", () => {
  let prisma: {
    ticketStage: { findMany: jest.Mock };
    ticket: { findFirst: jest.Mock };
    contact: { findFirst: jest.Mock };
  };
  let tickets: { createTicket: jest.Mock; moveTicket: jest.Mock };
  let svc: PipelineAutomationService;

  const STAGES = [
    { id: "st-new", pipelineId: "pl1", groupKey: "new", order: 0 },
    { id: "st-contacted", pipelineId: "pl1", groupKey: "contacted", order: 1 },
  ];

  beforeEach(() => {
    prisma = {
      ticketStage: { findMany: jest.fn().mockResolvedValue(STAGES) },
      ticket: { findFirst: jest.fn().mockResolvedValue(null) },
      contact: { findFirst: jest.fn().mockResolvedValue({ name: "Feras" }) },
    };
    tickets = {
      createTicket: jest.fn().mockResolvedValue({ id: "t1" }),
      moveTicket: jest.fn().mockResolvedValue({ id: "t1" }),
    };
    svc = new PipelineAutomationService(prisma as never, tickets as never);
  });

  it("creates a ticket in the 'new' stage when the contact has no open ticket", async () => {
    await svc.onInboundMessage("ws1", "c1", "conv1", "whatsapp", "hello there");
    expect(tickets.createTicket).toHaveBeenCalledWith("ws1", {
      pipelineId: "pl1",
      stageId: "st-new",
      contactId: "c1",
      conversationId: "conv1",
      title: "Feras",
      description: "hello there",
    });
  });

  it("does NOT create when an open ticket already exists", async () => {
    prisma.ticket.findFirst.mockResolvedValue({ id: "t-open" });
    await svc.onInboundMessage("ws1", "c1", "conv1", "whatsapp", "hi");
    expect(tickets.createTicket).not.toHaveBeenCalled();
  });

  it("no-ops (and doesn't throw) when the pipeline lacks new/contacted groups", async () => {
    prisma.ticketStage.findMany.mockResolvedValue([]);
    await expect(
      svc.onInboundMessage("ws1", "c1", "conv1", "whatsapp", "hi"),
    ).resolves.toBeUndefined();
    expect(tickets.createTicket).not.toHaveBeenCalled();
  });

  it("moves the contact's ticket from new to contacted on an outbound reply", async () => {
    prisma.ticket.findFirst.mockResolvedValue({ id: "t1" });
    await svc.onOutboundReply("ws1", "c1");
    // The lookup must be constrained to tickets sitting in the NEW stage.
    expect(prisma.ticket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ stageId: "st-new", contactId: "c1" }),
      }),
    );
    expect(tickets.moveTicket).toHaveBeenCalledWith("ws1", "t1", { stageId: "st-contacted" });
  });

  it("never moves a ticket that isn't in the new stage", async () => {
    prisma.ticket.findFirst.mockResolvedValue(null); // nothing in 'new'
    await svc.onOutboundReply("ws1", "c1");
    expect(tickets.moveTicket).not.toHaveBeenCalled();
  });

  it("swallows downstream failures instead of breaking message ingestion", async () => {
    tickets.createTicket.mockRejectedValue(new Error("db down"));
    await expect(
      svc.onInboundMessage("ws1", "c1", "conv1", "whatsapp", "hi"),
    ).resolves.toBeUndefined();
  });
});
