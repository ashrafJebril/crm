import { ConversationResolutionService, type Verdict } from "./conversation-resolution.service";

describe("ConversationResolutionService.apply", () => {
  let raw: any;
  let tickets: any;
  let realtime: any;
  let svc: ConversationResolutionService;
  const base: Verdict = {
    resolved: false, reason: null, confidence: 0.8, rationale: "r", issue_type: "none",
    issue_confidence: 0.9, sentiment: "neutral", summary: "s", ticket_title: null,
  };

  beforeEach(() => {
    raw = {
      conversation: { update: jest.fn().mockResolvedValue({ id: "c1", contactId: "ct1", channel: "whatsapp" }) },
      pipeline: {
        findFirst: jest.fn().mockResolvedValue({ id: "p-support", stages: [{ id: "s-open" }] }),
        create: jest.fn(),
      },
      ticket: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    tickets = { createTicket: jest.fn().mockResolvedValue({ id: "t1" }) };
    realtime = { emitToWorkspace: jest.fn() };
    svc = new ConversationResolutionService({ raw } as never, tickets, realtime);
  });

  const data = () => raw.conversation.update.mock.calls[0][0].data;

  it("a confident genuine ending is 'resolved', an unresolved ending is 'closed'", async () => {
    await svc.apply("c1", "ws", { ...base, resolved: true, reason: "customer_requested" });
    expect(data()).toMatchObject({ resolutionStatus: "resolved", resolution: "customer_requested" });
    raw.conversation.update.mockClear();
    await svc.apply("c1", "ws", { ...base, resolved: true, reason: "no_response" });
    expect(data()).toMatchObject({ resolutionStatus: "closed", resolution: "no_response" });
    expect(tickets.createTicket).not.toHaveBeenCalled();
  });

  it("below the confidence floor nothing is acted on", async () => {
    await svc.apply("c1", "ws", { ...base, resolved: true, reason: "resolved", confidence: 0.6, issue_type: "complaint", issue_confidence: 0.6 });
    expect(data()).toMatchObject({ resolutionStatus: "open", resolution: null, resolutionIssue: "none" });
    expect(tickets.createTicket).not.toHaveBeenCalled();
  });

  it("a complaint opens a Support ticket in the open stage", async () => {
    await svc.apply("c1", "ws", { ...base, issue_type: "complaint", ticket_title: "Room not cleaned", summary: "Dirty room." });
    expect(tickets.createTicket).toHaveBeenCalledWith("ws", {
      pipelineId: "p-support", stageId: "s-open", contactId: "ct1", conversationId: "c1",
      title: "[Complaint] Room not cleaned", description: "Dirty room.\n\nKewy AI: r",
    });
    expect(data()).toMatchObject({ resolutionIssue: "complaint", intent: "complaint" });
    expect(data()).not.toHaveProperty("escalated");
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws", "inbox.activity", expect.objectContaining({ conversationId: "c1" }));
  });

  it("an escalation flags the conversation too", async () => {
    await svc.apply("c1", "ws", { ...base, issue_type: "escalation", ticket_title: "Wants a manager" });
    expect(data()).toMatchObject({ escalated: true, resolutionIssue: "escalation" });
    expect(tickets.createTicket.mock.calls[0][1].title).toBe("[Escalation] Wants a manager");
  });

  it("never opens a second ticket while one is open for the conversation", async () => {
    raw.ticket.findFirst.mockResolvedValue({ id: "t-existing" });
    await svc.apply("c1", "ws", { ...base, issue_type: "complaint", ticket_title: "x" });
    expect(tickets.createTicket).not.toHaveBeenCalled();
  });

  it("creates the Support pipeline on first use", async () => {
    raw.pipeline.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "p-new", stages: [{ id: "s-new" }] });
    await expect(svc.supportPipeline("ws")).resolves.toEqual({ pipelineId: "p-new", stageId: "s-new" });
    const created = raw.pipeline.create.mock.calls[0][0].data;
    expect(created.key).toBe("support");
    expect(created.stages.create.map((s: any) => s.groupKey)).not.toContain("new");
  });
});
