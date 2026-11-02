/**
 * Runs the real sweep SQL against a real Postgres. Skipped unless
 * RESOLUTION_TEST_DATABASE_URL points at a migrated, disposable database —
 * the rest of the suite stays DB-free, as everywhere else in this repo.
 */
import { PrismaService } from "../prisma/prisma.service";
import { TicketsService } from "../tickets/tickets.service";
import { ConversationResolutionService, type Verdict } from "./conversation-resolution.service";

const url = process.env.RESOLUTION_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("ConversationResolutionService against Postgres", () => {
  const realFetch = global.fetch;
  let prisma: PrismaService;
  let svc: ConversationResolutionService;
  let verdict: Verdict;
  let calls: any[];
  const ago = (min: number) => new Date(Date.now() - min * 60_000);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.L_API_URL = "http://l.test";
    prisma = new PrismaService();
    const realtime = { emitToWorkspace: jest.fn() };
    svc = new ConversationResolutionService(prisma, new TicketsService(prisma, realtime as never), realtime as never);
  });
  afterAll(async () => {
    global.fetch = realFetch;
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    calls = [];
    verdict = {
      resolved: false, reason: null, confidence: 0.8, rationale: "Customer still waiting on a fix.",
      issue_type: "complaint", issue_confidence: 0.9, sentiment: "negative",
      summary: "Room was not cleaned.", ticket_title: "Room not cleaned",
    };
    global.fetch = jest.fn(async (u: any, init: any) => {
      calls.push({ url: String(u), body: JSON.parse(init.body), headers: init.headers });
      return { ok: true, status: 200, json: async () => verdict } as any;
    }) as any;
    await prisma.raw.$executeRawUnsafe(
      `TRUNCATE "TicketActivity","Ticket","TicketStage","Pipeline","Message","Conversation","Contact","Workspace" CASCADE`,
    );
  });

  async function seed(opts: { linked?: boolean; lastMin: number; checked?: Date | null }) {
    const ws = await prisma.raw.workspace.create({
      data: {
        name: "Acme", slug: `acme-${Math.random().toString(36).slice(2)}`,
        ...(opts.linked === false ? {} : { lEndpointId: "ep-1", lEndpointSecret: "sec" }),
      },
    });
    const contact = await prisma.raw.contact.create({
      data: { workspaceId: ws.id, name: "Lina", industry: "—", lifecycle: "customer", source: "whatsapp", lastSeen: "now" },
    });
    const conv = await prisma.raw.conversation.create({
      data: {
        workspaceId: ws.id, contactId: contact.id, lastAt: "now", lastFrom: "them", preview: "", channel: "whatsapp",
        status: "human", intent: "", confidence: 0, resolutionCheckedAt: opts.checked ?? null,
      },
    });
    await prisma.raw.message.create({ data: { workspaceId: ws.id, conversationId: conv.id, from: "them", body: "The room wasn't cleaned", t: "10:00", createdAt: ago(opts.lastMin + 1) } });
    await prisma.raw.message.create({ data: { workspaceId: ws.id, conversationId: conv.id, from: "ai", body: "Sorry, telling housekeeping", t: "10:01", createdAt: ago(opts.lastMin) } });
    return { ws, contact, conv };
  }

  it("judges a quiet thread, opens one Support ticket, and never twice", async () => {
    const { ws, conv } = await seed({ lastMin: 40 });
    await svc.sweep();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://l.test/api/v1/webhooks/ep-1/resolution");
    expect(calls[0].headers["x-webhook-secret"]).toBe("sec");
    expect(calls[0].body.messages.map((m: any) => m.sender)).toEqual(["customer", "ai"]);

    const c = await prisma.raw.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(c).toMatchObject({ resolutionStatus: "open", resolutionIssue: "complaint", intent: "complaint", resolutionAttempts: 0 });

    const tickets = await prisma.raw.ticket.findMany({ where: { workspaceId: ws.id }, include: { pipeline: true, stage: true } });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ conversationId: conv.id, title: "[Complaint] Room not cleaned" });
    expect(tickets[0].pipeline.key).toBe("support");
    expect(tickets[0].stage.key).toBe("open");

    // Already judged at its newest message → not due again.
    await svc.sweep();
    expect(calls).toHaveLength(1);
  });

  it("an escalation flags the conversation; a confident ending marks it resolved", async () => {
    verdict = { ...verdict, resolved: true, reason: "abandoned", confidence: 0.85, issue_type: "escalation", ticket_title: "Wants a manager" };
    const { conv } = await seed({ lastMin: 45 });
    await svc.sweep();
    const c = await prisma.raw.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(c).toMatchObject({ escalated: true, resolutionStatus: "closed", resolution: "abandoned", status: "human" });
    expect(c.resolvedAt).toBeInstanceOf(Date);
  });

  it("low confidence is stored but not acted on", async () => {
    verdict = { ...verdict, resolved: true, reason: "resolved", confidence: 0.5, issue_confidence: 0.4 };
    const { ws, conv } = await seed({ lastMin: 40 });
    await svc.sweep();
    const c = await prisma.raw.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(c).toMatchObject({ resolutionStatus: "open", resolution: null, resolutionIssue: "none" });
    expect(await prisma.raw.ticket.count({ where: { workspaceId: ws.id } })).toBe(0);
  });

  it("skips threads still inside the window, unlinked workspaces and history marked checked", async () => {
    await seed({ lastMin: 10 });
    await seed({ lastMin: 40, linked: false });
    await seed({ lastMin: 40, checked: new Date() });
    await svc.sweep();
    expect(calls).toHaveLength(0);
  });

  it("a customer writing again clears the verdict, and the thread is judged afresh later", async () => {
    const { ws, conv } = await seed({ lastMin: 40 });
    await svc.sweep();
    await prisma.raw.message.create({ data: { workspaceId: ws.id, conversationId: conv.id, from: "them", body: "still dirty!", t: "11:00" } });
    await svc.sweep();
    const c = await prisma.raw.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(c.resolutionStatus).toBeNull();
    expect(calls).toHaveLength(1); // the new message is inside the window
  });

  it("a failed call is recorded and retried at most 3 times, 10 minutes apart", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })) as any;
    const { conv } = await seed({ lastMin: 40 });
    await svc.sweep();
    let c = await prisma.raw.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(c).toMatchObject({ resolutionAttempts: 1, resolutionError: "Kewy AI answered HTTP 502" });
    await svc.sweep(); // too soon to retry
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    await prisma.raw.conversation.update({ where: { id: conv.id }, data: { resolutionCheckedAt: ago(11) } });
    await svc.sweep();
    c = await prisma.raw.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(c.resolutionAttempts).toBe(2);
  });
});
