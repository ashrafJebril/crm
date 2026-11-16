import { NotFoundException } from "@nestjs/common";
import { PermissionService } from "./permission.service";
import { ConversationsService } from "../conversations/conversations.service";
import { ConversationLabelsService } from "../conversations/conversation-labels.service";
import { SearchService } from "../search/search.service";
import { NotesService } from "../notes/notes.service";
import { canOpenRecord } from "../notifications/record-access";
import { WhatsAppController } from "../integrations/whatsapp.controller";
import { ZernioController } from "../integrations/zernio.controller";
import { TicketsController } from "../tickets/tickets.controller";
import { ContactsService } from "../contacts/contacts.service";
import type { Viewer } from "./visibility";
import { DashboardController } from "../dashboard/dashboard.module";
import { FacebookController } from "../integrations/facebook.controller";
import { InstagramController } from "../integrations/instagram.controller";
import { WorkflowsService } from "../workflows/workflows.service";
import { MediaService } from "../media/media.service";
import { UpdateTicketDto } from "../tickets/tickets.dto";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { makeFakePrisma } from "../channels/test-prisma";
import { AdSourcesService } from "../ad-attribution/ad-sources.service";
import { createAudienceDb } from "../segments/audience-test-db";
import { predicateWorld, WS as SP16_WS } from "../segments/__fixtures__/audience-world";
import { SegmentsController } from "../segments/segments.controller";
import { SegmentsService } from "../segments/segments.service";
import { TicketAttachmentsService } from "../tickets/ticket-attachments.service";
import { TicketsService } from "../tickets/tickets.service";
import type { Prisma } from "@prisma/client";
import { InsightsService } from "../insights/insights.service";
import { salesOracle, supportOracle } from "../insights/insights-oracle";
import { parseRange } from "../insights/insights-range";
import { ASSIGNED, SALES_ASSIGNED, SALES_OWNER } from "../insights/insights-expected";
import {
  INSIGHTS_WORLD,
  RANGE as INSIGHTS_RANGE,
  SALES_NOW,
  SALES_RANGE,
  U as INSIGHTS_U,
} from "../insights/__fixtures__/insights-world";

/**
 * Review Focus 1: with conversationVisibility = "assigned", an unassigned
 * conversation must 404 (or be absent) through every path a member can reach.
 * The real PermissionService runs over a small in-memory prisma fake.
 */

const WS = "ws1";
const ME = "me";
const MINE = "c-mine"; // assigned to me
const OTHER = "c-other"; // assigned to somebody else
const NONE = "c-none"; // unassigned

type Row = { id: string; workspaceId: string; assigneeId: string | null; contactId: string; channel: string };
const rows: Row[] = [
  { id: MINE, workspaceId: WS, assigneeId: ME, contactId: "ct", channel: "whatsapp" },
  { id: OTHER, workspaceId: WS, assigneeId: "someone", contactId: "ct", channel: "whatsapp" },
  { id: NONE, workspaceId: WS, assigneeId: null, contactId: "ct", channel: "whatsapp" },
];

function matches(r: Row, where: any = {}): boolean {
  if (where.id !== undefined) {
    if (typeof where.id === "string" ? r.id !== where.id : !where.id.in.includes(r.id)) return false;
  }
  if (where.workspaceId !== undefined && r.workspaceId !== where.workspaceId) return false;
  if (where.assigneeId !== undefined && r.assigneeId !== where.assigneeId) return false;
  if (where.contactId !== undefined && r.contactId !== where.contactId) return false;
  return true;
}

function makePrisma(perms: Record<string, string[]>, visibility: "assigned" | "all") {
  const full = (r: Row) => ({ ...r, messages: [], labels: [], contact: { externalId: "1", phone: "1" }, updatedAt: new Date(), version: 1, status: "open", escalated: false });
  const prisma: any = {
    workspaceMember: {
      findUnique: jest.fn().mockResolvedValue({
        role: "custom",
        roleRef: { id: "r1", isSystem: false, key: null, name: "R", nameAr: "R", permissions: perms, conversationVisibility: visibility },
      }),
      findFirst: jest.fn().mockResolvedValue({ id: "m", userId: ME }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    conversation: {
      findFirst: jest.fn(async ({ where }: any) => {
        const r = rows.find((x) => matches(x, where));
        return r ? full(r) : null;
      }),
      findMany: jest.fn(async ({ where }: any) => rows.filter((x) => matches(x, where)).map(full)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({ id: MINE, aiEnabled: true, aiPausedAt: null }),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { unread: 0 } }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    conversationLabel: { findMany: jest.fn().mockResolvedValue([]) },
    conversationLabelLink: { deleteMany: jest.fn(), createMany: jest.fn() },
    // SP-19: list mirrors legacy integrations and resolves effective channels.
    integration: { findMany: jest.fn().mockResolvedValue([]) },
    channel: { findMany: jest.fn().mockResolvedValue([]) },
    message: {
      findMany: jest.fn().mockResolvedValue([{ id: "m1" }]),
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: "m1" }),
    },
    contact: { findFirst: jest.fn().mockResolvedValue({ id: "ct", name: "C" }), count: jest.fn().mockResolvedValue(0) },
    template: { count: jest.fn().mockResolvedValue(0) },
    campaign: { findFirst: jest.fn(), count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    ticket: { findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    note: {
      findMany: jest.fn().mockResolvedValue([{ id: "n" }]),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "n1", ...data })),
      update: jest.fn(),
      delete: jest.fn(),
    },
    noteSeen: { upsert: jest.fn() },
    appointment: { findFirst: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    user: { findUnique: jest.fn().mockResolvedValue({ name: "x" }) },
    // SP-15: re-hosted ad creatives are visible like staff uploads (none here).
    adSource: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn().mockResolvedValue([]),
  };
  return prisma;
}

const ASSIGNED_PERMS = { conversations: ["view", "update"], contacts: ["view"], tickets: ["view", "create"] };
const viewer: Viewer = { userId: ME };

describe("assigned-only conversation visibility: side doors", () => {
  let prisma: any;
  let perm: PermissionService;
  let realtime: any;

  beforeEach(() => {
    prisma = makePrisma(ASSIGNED_PERMS, "assigned");
    perm = new PermissionService(prisma);
    realtime = { emitToWorkspace: jest.fn() };
  });

  const convs = () =>
    new ConversationsService(prisma, realtime, { queueReply: jest.fn() } as never, undefined, perm);

  describe("ConversationsService", () => {
    it("list contains only my conversations (so inbox buckets/counts only see them)", async () => {
      const res = await convs().list(WS, viewer);
      expect(res.map((c: any) => c.id)).toEqual([MINE]);
    });
    it("list without a viewer (internal caller) is unfiltered", async () => {
      expect((await convs().list(WS)).length).toBe(3);
    });
    it("list for a bypass session (super-admin/impersonation) is unfiltered", async () => {
      expect((await convs().list(WS, { userId: ME, bypass: true })).length).toBe(3);
    });
    it("get: hidden -> 404, mine -> ok", async () => {
      await expect(convs().get(WS, NONE, viewer)).rejects.toThrow(NotFoundException);
      await expect(convs().get(WS, OTHER, viewer)).rejects.toThrow(NotFoundException);
      await expect(convs().get(WS, MINE, viewer)).resolves.toMatchObject({ id: MINE });
    });
    it("messages: hidden -> 404 and no message read, mine -> ok", async () => {
      await expect(convs().listMessages(WS, NONE, viewer)).rejects.toThrow(NotFoundException);
      expect(prisma.message.findMany).not.toHaveBeenCalled();
      await expect(convs().listMessages(WS, MINE, viewer)).resolves.toHaveLength(1);
    });
    it("update (PATCH): hidden -> 404 and no write, mine -> ok", async () => {
      await expect(convs().update(WS, NONE, { status: "resolved" } as never, ME, viewer)).rejects.toThrow(NotFoundException);
      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
      await expect(convs().update(WS, MINE, { status: "resolved" } as never, ME, viewer)).resolves.toBeDefined();
    });
    it("markRead: hidden -> 404 and no write, mine -> ok", async () => {
      await expect(convs().markRead(WS, NONE, viewer)).rejects.toThrow(NotFoundException);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      await expect(convs().markRead(WS, MINE, viewer)).resolves.toMatchObject({ unread: 0 });
    });
    it("setAi: hidden -> 404, mine -> ok", async () => {
      await expect(convs().setAi(WS, NONE, true, viewer)).rejects.toThrow(NotFoundException);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      await expect(convs().setAi(WS, MINE, true, viewer)).resolves.toBeDefined();
    });
    it("delete: hidden -> 404, mine -> ok", async () => {
      await expect(convs().remove(WS, NONE, viewer)).rejects.toThrow(NotFoundException);
      expect(prisma.conversation.delete).not.toHaveBeenCalled();
      await expect(convs().remove(WS, MINE, viewer)).resolves.toEqual({ ok: true });
    });
    it("post message: hidden -> 404, no message written", async () => {
      await expect(convs().addMessage(WS, NONE, { body: "x", from: "human" } as never, viewer)).rejects.toThrow(NotFoundException);
      expect(prisma.message.create).not.toHaveBeenCalled();
    });
  });

  describe("conversation labels", () => {
    const svc = () => new ConversationLabelsService(prisma, realtime, perm);
    it("setForConversation: hidden -> 404 and no link write, mine -> ok", async () => {
      await expect(svc().setForConversation(WS, NONE, [], viewer)).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      await expect(svc().setForConversation(WS, MINE, [], viewer)).resolves.toEqual({ labelIds: [] });
    });
  });

  describe("search", () => {
    const svc = () => new SearchService(prisma, perm);
    // Flatten nested Prisma.sql fragments: returns the SQL text and, via valuesOf, the bound values.
    const flat = (call: any[]) => {
      const text = [(call[0] as string[]).join("?")];
      const vals: unknown[] = [];
      for (const a of call.slice(1)) {
        if (a && typeof a === "object" && Array.isArray((a as any).strings)) {
          text.push((a as any).strings.join("?"));
          vals.push(...(a as any).values);
        } else vals.push(a);
      }
      return { text: text.join(" "), vals };
    };
    const sqlOf = (call: any[]) => flat(call).text;
    it("conversation hits are restricted to my assigned conversations", async () => {
      await svc().search(WS, "hello", 8, viewer);
      const conv = prisma.$queryRaw.mock.calls.find((c: any[]) => sqlOf(c).includes('FROM "Conversation"'));
      expect(sqlOf(conv)).toContain('"assigneeId"');
      expect(flat(conv).vals).toContain(ME);
    });
    it("an unfiltered viewer's conversation search has no assignee clause", async () => {
      await svc().search(WS, "hello", 8);
      const conv = prisma.$queryRaw.mock.calls.find((c: any[]) => sqlOf(c).includes('FROM "Conversation"'));
      expect(sqlOf(conv)).not.toContain('"assigneeId"');
    });
    it("without conversations.view the conversations list is empty and not queried", async () => {
      prisma = makePrisma({ contacts: ["view"] }, "all");
      perm = new PermissionService(prisma);
      const res = await svc().search(WS, "hello", 8, viewer);
      expect(res.conversations).toEqual([]);
      expect(prisma.$queryRaw.mock.calls.some((c: any[]) => sqlOf(c).includes('FROM "Conversation"'))).toBe(false);
    });
    it("without contacts.view the contacts list is empty and not queried (also the 1-char fallback)", async () => {
      prisma = makePrisma({ conversations: ["view"] }, "all");
      perm = new PermissionService(prisma);
      const res = await svc().search(WS, "hello", 8, viewer);
      expect(res.contacts).toEqual([]);
      await svc().search(WS, "h", 8, viewer);
      expect(prisma.$queryRaw.mock.calls.some((c: any[]) => sqlOf(c).includes('FROM "Contact"'))).toBe(false);
    });
  });

  describe("notes", () => {
    const svc = () => new NotesService(prisma, { notify: jest.fn() } as never, perm);
    it("conversation-scoped list: hidden -> 404 and no read, mine -> ok", async () => {
      await expect(svc().listForConversation(WS, NONE, viewer)).rejects.toThrow(NotFoundException);
      expect(prisma.note.findMany).not.toHaveBeenCalled();
      await expect(svc().listForConversation(WS, MINE, viewer)).resolves.toHaveLength(1);
    });
    it("create with a hidden conversationId -> 404 and nothing written, mine -> ok", async () => {
      await expect(
        svc().create(WS, { contactId: "ct", conversationId: OTHER, body: "hi" } as never, ME, viewer),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.note.create).not.toHaveBeenCalled();
      await expect(
        svc().create(WS, { contactId: "ct", conversationId: MINE, body: "hi" } as never, ME, viewer),
      ).resolves.toBeDefined();
    });
    it("an opaque FB/IG thread's notes are hidden from an assigned-only viewer (provider-live ruling)", async () => {
      for (const opaque of ["t_123", "ig:456"]) {
        prisma.note.findMany.mockResolvedValue([{ id: "n", conversationId: opaque }]);
        await expect(svc().listForConversation(WS, opaque, viewer)).resolves.toEqual([]);
      }
      await expect(svc().listForConversation(WS, "t_123", { userId: ME, bypass: true })).resolves.toHaveLength(1);
    });
    it("an opaque (non-DB) conversationId is not blocked on create", async () => {
      await expect(
        svc().create(WS, { contactId: "ct", conversationId: "fb-thread-1", body: "hi" } as never, ME, viewer),
      ).resolves.toBeDefined();
    });
  });

  describe("canOpenRecord (mentions + notifications)", () => {
    it("hidden conversation -> false, mine -> true", async () => {
      expect(await canOpenRecord(prisma, WS, ME, "conversation", NONE, perm)).toBe(false);
      expect(await canOpenRecord(prisma, WS, ME, "conversation", MINE, perm)).toBe(true);
    });
    it("a record kind the member cannot view -> false", async () => {
      prisma.ticket.findFirst.mockResolvedValue({ id: "t" });
      prisma.campaign.findFirst.mockResolvedValue({ id: "cp" });
      expect(await canOpenRecord(prisma, WS, ME, "ticket", "t", perm)).toBe(true);
      expect(await canOpenRecord(prisma, WS, ME, "campaign", "cp", perm)).toBe(false);
    });
    it("a non-member -> false", async () => {
      prisma.workspaceMember.findUnique.mockResolvedValue(null);
      expect(await canOpenRecord(prisma, WS, ME, "conversation", MINE, perm)).toBe(false);
    });
  });

  describe("integrations inbox send routes", () => {
    const wa = () => ({
      sendInConversation: jest.fn().mockResolvedValue({ ok: 1 }),
      sendTemplateInConversation: jest.fn().mockResolvedValue({ ok: 1 }),
    });
    const handoff = { humanReplied: jest.fn() };
    it("WhatsApp send + send-template: hidden -> 404 before sending", async () => {
      const w = wa();
      const c = new WhatsAppController(w as never, handoff as never, perm);
      await expect(c.sendInConversation(WS, NONE, { message: "hi" } as never, viewer)).rejects.toThrow(NotFoundException);
      await expect(c.sendTemplateInConversation(WS, NONE, { name: "t", language: "ar" } as never, viewer)).rejects.toThrow(NotFoundException);
      expect(w.sendInConversation).not.toHaveBeenCalled();
      expect(w.sendTemplateInConversation).not.toHaveBeenCalled();
      await expect(c.sendInConversation(WS, MINE, { message: "hi" } as never, viewer)).resolves.toBeDefined();
    });
    it("Zernio db-conversations send + send-template: hidden -> 404 before sending", async () => {
      const z = {
        sendInDbConversation: jest.fn().mockResolvedValue({ ok: 1 }),
        sendTemplateInDbConversation: jest.fn().mockResolvedValue({ ok: 1 }),
      };
      const c = new ZernioController(z as never, handoff as never, perm);
      await expect(c.sendInDbConversation(WS, NONE, { message: "hi" } as never, viewer)).rejects.toThrow(NotFoundException);
      await expect(c.sendTemplateInDbConversation(WS, NONE, { name: "t", language: "ar" } as never, viewer)).rejects.toThrow(NotFoundException);
      expect(z.sendInDbConversation).not.toHaveBeenCalled();
      expect(z.sendTemplateInDbConversation).not.toHaveBeenCalled();
      await expect(c.sendInDbConversation(WS, MINE, { message: "hi" } as never, viewer)).resolves.toBeDefined();
    });
  });

  describe("other readers of a DB conversation by id", () => {
    it("tickets/from-conversation: hidden -> 404 before creating", async () => {
      const svc = { createFromConversation: jest.fn().mockResolvedValue({ id: "t" }) };
      const c = new TicketsController(svc as never, {} as never, perm);
      await expect(c.createFromConversation(WS, ME, NONE, {} as never, viewer)).rejects.toThrow(NotFoundException);
      expect(svc.createFromConversation).not.toHaveBeenCalled();
      await expect(c.createFromConversation(WS, ME, MINE, {} as never, viewer)).resolves.toBeDefined();
    });
    it("contact summary only counts/lists my conversations", async () => {
      prisma.contact.findFirst.mockResolvedValue({ id: "ct", workspaceId: WS, name: "C" });
      const svc = new ContactsService(prisma, {} as never, undefined, undefined, perm);
      jest.spyOn(svc, "get").mockResolvedValue({ id: "ct" } as never);
      const res: any = await svc.summary(WS, "ct", viewer);
      expect(res.recentConversations.map((c: any) => c.id)).toEqual([MINE]);
      expect(res.stats.conversations).toBe(1);
      expect(prisma.message.count.mock.calls[0][0].where.conversation.assigneeId).toBe(ME);
    });
  });

  describe("visibility 'all' members are unaffected", () => {
    it("list/get see everything", async () => {
      prisma = makePrisma(ASSIGNED_PERMS, "all");
      perm = new PermissionService(prisma);
      expect((await convs().list(WS, viewer)).length).toBe(3);
      await expect(convs().get(WS, NONE, viewer)).resolves.toMatchObject({ id: NONE });
    });
  });

  describe("dashboard summary", () => {
    it("every conversation/message aggregate carries the viewer's scope", async () => {
      prisma.message.findMany.mockResolvedValue([]);
      const c = new DashboardController(prisma, perm);
      await c.summary(WS, undefined, viewer);
      for (const fn of [prisma.conversation.count, prisma.conversation.aggregate, prisma.conversation.groupBy]) {
        for (const call of fn.mock.calls) expect(call[0].where.assigneeId).toBe(ME);
      }
      expect(prisma.message.findMany.mock.calls[0][0].where.conversation).toEqual({ assigneeId: ME });
      const raws = prisma.$queryRaw.mock.calls.map((call: any[]) => {
        const text = [(call[0] as string[]).join("?")];
        for (const a of call.slice(1)) if (a && Array.isArray((a as any).strings)) text.push((a as any).strings.join("?"));
        return text.join(" ");
      });
      expect(raws.length).toBe(2);
      for (const t of raws) expect(t).toContain('"assigneeId"');
    });
    it("unfiltered for a bypass viewer", async () => {
      prisma.message.findMany.mockResolvedValue([]);
      const c = new DashboardController(prisma, perm);
      await c.summary(WS, undefined, { userId: ME, bypass: true });
      expect(prisma.message.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS });
      expect(prisma.conversation.count.mock.calls[0][0].where.assigneeId).toBeUndefined();
    });
  });

  describe("notes by contact/ticket hide notes of hidden and opaque conversations", () => {
    const svc = () => new NotesService(prisma, { notify: jest.fn() } as never, perm);
    const notes = [
      { id: "n-none", conversationId: NONE },
      { id: "n-mine", conversationId: MINE },
      { id: "n-opaque", conversationId: "t_123" },
      { id: "n-opaque-ig", conversationId: "ig:456" },
      { id: "n-plain", conversationId: null },
    ];
    it("listForContact and listForTicket", async () => {
      prisma.note.findMany.mockResolvedValue(notes);
      for (const res of [await svc().listForContact(WS, "ct", viewer), await svc().listForTicket(WS, "t1", viewer)]) {
        expect(res.map((n: any) => n.id)).toEqual(["n-mine", "n-plain"]);
      }
      expect((await svc().listForContact(WS, "ct")).length).toBe(5);
    });
  });

  describe("provider-live thread routes", () => {
    const z = () => ({
      listConversations: jest.fn().mockResolvedValue([{ id: "x" }]),
      getMessages: jest.fn().mockResolvedValue([]),
      sendInConversation: jest.fn().mockResolvedValue({}),
    });
    it("zernio: [] for lists, 404 for by-id and send, when assigned", async () => {
      const zs = z();
      const c = new ZernioController(zs as never, {} as never, perm);
      expect(await c.conversations(WS, undefined, viewer)).toEqual([]);
      await expect(c.messages(WS, "t", undefined, viewer)).rejects.toThrow(NotFoundException);
      await expect(c.send(WS, "t", { accountId: "a", message: "m" } as never, viewer)).rejects.toThrow(NotFoundException);
      expect(zs.listConversations).not.toHaveBeenCalled();
      expect(zs.sendInConversation).not.toHaveBeenCalled();
    });
    it("zernio unchanged for 'all' members and bypass", async () => {
      const zs = z();
      const allPerm = new PermissionService(makePrisma(ASSIGNED_PERMS, "all"));
      expect(await new ZernioController(zs as never, {} as never, allPerm).conversations(WS, undefined, viewer)).toEqual([{ id: "x" }]);
      expect(await new ZernioController(zs as never, {} as never, perm).conversations(WS, undefined, { userId: ME, bypass: true })).toEqual([{ id: "x" }]);
    });
    it("facebook: [] / 404 when assigned, passthrough for 'all'", async () => {
      const fb = { listConversations: jest.fn().mockResolvedValue([1]), listMessagesInConversation: jest.fn(), sendDirectMessage: jest.fn() };
      const c = new FacebookController(fb as never, {} as never, perm);
      expect(await c.listConversations(WS, viewer)).toEqual([]);
      await expect(c.listMessagesInConversation(WS, "t", viewer)).rejects.toThrow(NotFoundException);
      await expect(c.sendDirectMessage(WS, "r", { message: "m" } as never, viewer)).rejects.toThrow(NotFoundException);
      expect(fb.sendDirectMessage).not.toHaveBeenCalled();
      const allPerm = new PermissionService(makePrisma(ASSIGNED_PERMS, "all"));
      expect(await new FacebookController(fb as never, {} as never, allPerm).listConversations(WS, viewer)).toEqual([1]);
    });
    it("instagram: [] / 404 when assigned; DB-id send follows conversation visibility", async () => {
      const ig = { listConversations: jest.fn().mockResolvedValue([1]), listMessagesInConversation: jest.fn(), sendDirectMessage: jest.fn(), sendInConversation: jest.fn().mockResolvedValue({}) };
      const c = new InstagramController(ig as never, { humanReplied: jest.fn() } as never, perm);
      expect(await c.listConversations(WS, viewer)).toEqual([]);
      await expect(c.listMessages(WS, "t", viewer)).rejects.toThrow(NotFoundException);
      await expect(c.sendDirectMessage(WS, "ig", { message: "m" }, viewer)).rejects.toThrow(NotFoundException);
      await expect(c.send(WS, NONE, { message: "m" }, viewer)).rejects.toThrow(NotFoundException);
      expect(ig.sendInConversation).not.toHaveBeenCalled();
      await expect(c.send(WS, MINE, { message: "m" }, viewer)).resolves.toBeDefined();
    });
  });

  describe("ticket creation", () => {
    it("POST /tickets with a hidden conversationId -> 404 before creating", async () => {
      const svc = { createTicket: jest.fn().mockResolvedValue({ id: "t" }) };
      const c = new TicketsController(svc as never, {} as never, perm);
      await expect(c.createTicket(WS, ME, { conversationId: NONE } as never, viewer)).rejects.toThrow(NotFoundException);
      expect(svc.createTicket).not.toHaveBeenCalled();
      await expect(c.createTicket(WS, ME, { conversationId: MINE } as never, viewer)).resolves.toBeDefined();
    });
  });

  describe("workflow runs", () => {
    const run = (id: string, trigger: Record<string, unknown>) => ({
      id, status: "completed", isTest: false, error: null, startedAt: new Date(0), completedAt: null,
      stepsSnapshot: {}, context: { trigger, steps: { s1: { ok: true } } }, result: { reply: "secret" },
    });
    const runs = [
      run("r-mine", { conversation: { id: MINE, channel: "whatsapp" }, message: { body: "hi" } }),
      run("r-other", { conversation: { id: OTHER, channel: "whatsapp" }, message: { body: "hidden text" } }),
      run("r-flat", { conversationId: NONE }),
      run("r-ticket", { ticket: { id: "t", conversationId: OTHER } }),
      run("r-none", { contact: { id: "ct" }, message: { body: "webhook text" } }),
    ];
    const svc = () => {
      prisma.workflow = {
        findFirst: jest.fn().mockResolvedValue({
          id: "w", name: "w", status: "active", triggerType: "x", triggerConfig: {}, steps: {},
          webhookSecret: null, createdAt: new Date(0), updatedAt: new Date(0),
        }),
      };
      prisma.workflowRun = {
        findMany: jest.fn().mockResolvedValue(runs),
        findFirst: jest.fn(async ({ where }: any) => runs.find((r) => r.id === where.id) ?? null),
      };
      return new WorkflowsService(prisma, {} as never, perm);
    };

    it("list: drops runs on hidden conversations; strips trigger.message and result when there is no conversation", async () => {
      const res: any[] = await svc().listRuns(WS, "w", viewer);
      expect(res.map((r) => r.id)).toEqual(["r-mine", "r-none"]);
      expect(res[0].context.trigger.message).toEqual({ body: "hi" });
      expect(res[0].result).toEqual({ reply: "secret" });
      expect(res[1].context.trigger.message).toBeUndefined();
      expect(res[1].context.trigger.contact).toEqual({ id: "ct" });
      expect(res[1].result).toBeNull();
    });

    it("get: hidden -> 404, mine -> ok, no-conversation run is redacted", async () => {
      await expect(svc().getRun(WS, "w", "r-other", viewer)).rejects.toThrow(NotFoundException);
      await expect(svc().getRun(WS, "w", "r-flat", viewer)).rejects.toThrow(NotFoundException);
      await expect(svc().getRun(WS, "w", "r-ticket", viewer)).rejects.toThrow(NotFoundException);
      await expect(svc().getRun(WS, "w", "r-mine", viewer)).resolves.toMatchObject({ id: "r-mine" });
      const none: any = await svc().getRun(WS, "w", "r-none", viewer);
      expect(none.context.trigger.message).toBeUndefined();
      expect(none.result).toBeNull();
    });

    it("unfiltered for 'all' members, bypass sessions and internal callers", async () => {
      expect((await svc().listRuns(WS, "w", { userId: ME, bypass: true })).length).toBe(5);
      expect((await svc().listRuns(WS, "w")).length).toBe(5);
      prisma = makePrisma(ASSIGNED_PERMS, "all");
      perm = new PermissionService(prisma);
      const all: any[] = await svc().listRuns(WS, "w", viewer);
      expect(all.length).toBe(5);
      expect(all[4].result).toEqual({ reply: "secret" });
    });
  });

  describe("media library", () => {
    const media = [
      { id: "med-staff", uploadedById: "u9", storageKind: "spaces", storedPath: "a", mimeType: "image/png" },
      { id: "med-mine", uploadedById: null, storageKind: "spaces", storedPath: "b", mimeType: "image/png" },
      { id: "med-url", uploadedById: null, storageKind: "spaces", storedPath: "c", mimeType: "image/png" },
      { id: "med-hidden", uploadedById: null, storageKind: "spaces", storedPath: "d", mimeType: "image/png" },
    ];
    // Messages: attach is a media id, or a public URL containing it.
    const messages = [
      { conversationId: MINE, attach: "med-mine" },
      { conversationId: MINE, attach: "https://x/api/media/med-url/public?token=t" },
      { conversationId: OTHER, attach: "med-hidden" },
    ];
    const svc = () => {
      prisma.media = {
        findMany: jest.fn().mockResolvedValue(media),
        findFirst: jest.fn(async ({ where }: any) => media.find((m) => m.id === where.id) ?? null),
        delete: jest.fn().mockResolvedValue({}),
      };
      prisma.message.findMany = jest.fn(async ({ where }: any) =>
        messages
          .filter((m) => rows.some((r) => r.id === m.conversationId && matches(r, where.conversation ?? {})))
          .filter((m) => where.OR.some((o: any) => m.attach.includes(o.attach.contains))),
      );
      const storage = { kind: "local", getSignedUrl: jest.fn().mockResolvedValue("signed"), delete: jest.fn() };
      return new MediaService(prisma, storage as never, perm);
    };

    it("list: staff uploads plus media on visible messages only", async () => {
      const res: any[] = await svc().list(WS, viewer);
      expect(res.map((m) => m.id)).toEqual(["med-staff", "med-mine", "med-url"]);
      expect(prisma.message.findMany.mock.calls[0][0].where.conversation).toEqual({ assigneeId: ME });
    });

    it("file: same rule, 404 otherwise", async () => {
      const s = svc();
      await expect(s.resolveServe(WS, "med-hidden", 3600, viewer)).rejects.toThrow(NotFoundException);
      await expect(s.resolveServe(WS, "med-mine", 3600, viewer)).resolves.toBeDefined();
      await expect(s.resolveServe(WS, "med-staff", 3600, viewer)).resolves.toBeDefined();
    });

    it("delete: a hidden inbound attachment -> 404, nothing removed", async () => {
      const s = svc();
      await expect(s.remove(WS, "med-hidden", viewer)).rejects.toThrow(NotFoundException);
      expect(prisma.media.delete).not.toHaveBeenCalled();
    });

    it("unfiltered for 'all' members and bypass", async () => {
      expect((await svc().list(WS, { userId: ME, bypass: true })).length).toBe(4);
      prisma = makePrisma(ASSIGNED_PERMS, "all");
      perm = new PermissionService(prisma);
      expect((await svc().list(WS, viewer)).length).toBe(4);
    });
  });

  describe("ticket conversation link (M7)", () => {
    it("PATCH /tickets/:id cannot set or change conversationId (rejected by the global ValidationPipe)", async () => {
      const dto = plainToInstance(UpdateTicketDto, { title: "x", conversationId: NONE });
      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      expect(errors.map((e) => e.property)).toEqual(["conversationId"]);
    });
  });
});

/**
 * SP-15 Review Focus 4: `GET /ad-sources/:id/conversations` is ANDed with the
 * viewer's conversation scope. The real PermissionService and AdSourcesService
 * over the in-memory Prisma double.
 */
describe("SP-15 per-ad conversation list", () => {
  const WS1 = "ws1";
  const t = (min: number) => new Date(Date.UTC(2026, 10, 15, 9, min));
  const touch = (id: string, conversationId: string, min: number, firstTouch = false) => ({
    id,
    workspaceId: WS1,
    adSourceId: "ad-1",
    conversationId,
    contactId: `ct-${conversationId}`,
    channelId: "ch-1",
    messageId: `msg-${id}`,
    provider: "meta",
    ctwaClid: "secret-clid",
    firstTouch,
    referredAt: t(min),
  });
  const conversation = (id: string, assigneeId: string | null, workspaceId = WS1) => ({
    id,
    workspaceId,
    contactId: `ct-${id}`,
    channelId: "ch-1",
    status: "human",
    assigneeId,
    adSourceId: "ad-1",
  });
  function build() {
    const prisma = makeFakePrisma({
      workspace: [
        { id: WS1, timezone: "Asia/Riyadh" },
        { id: "ws2", timezone: "Asia/Riyadh" },
      ],
      role: [
        { id: "r-owner", workspaceId: WS1, key: "owner", isSystem: true, name: "Owner", nameAr: "Owner", permissions: { "*": ["*"] }, conversationVisibility: "all" },
        { id: "r-agent", workspaceId: WS1, key: null, isSystem: false, name: "A", nameAr: "A", permissions: { conversations: ["view"] }, conversationVisibility: "assigned" },
      ],
      workspaceMember: [
        { id: "wm1", workspaceId: WS1, userId: "owner", role: "owner", roleId: null },
        { id: "wm2", workspaceId: WS1, userId: ME, role: "custom", roleId: "r-agent" },
      ],
      adSource: [
        { id: "ad-1", workspaceId: WS1, sourceType: "ad", sourceId: "1", lastReferredAt: t(9) },
        { id: "ad-foreign", workspaceId: "ws2", sourceType: "ad", sourceId: "1", lastReferredAt: t(9) },
      ],
      conversation: [conversation("cv-mine", ME), conversation("cv-other", "someone"), conversation("cv-none", null), conversation("cv-ws2", ME, "ws2")],
      contact: [
        { id: "ct-cv-mine", workspaceId: WS1, name: "Mine" },
        { id: "ct-cv-other", workspaceId: WS1, name: "Other" },
        { id: "ct-cv-none", workspaceId: WS1, name: "None" },
      ],
      adReferral: [
        touch("r1", "cv-mine", 1, true),
        touch("r2", "cv-other", 2, true),
        touch("r3", "cv-none", 3, true),
        touch("r4", "cv-mine", 4),
        touch("r5", "cv-other", 5),
        { ...touch("r-ws2", "cv-ws2", 6, true), workspaceId: "ws2", adSourceId: "ad-foreign" },
      ],
    });
    const perm = new PermissionService(prisma);
    return { prisma, svc: new AdSourcesService(prisma, perm) };
  }
  const RANGE = { from: "2026-11-01", to: "2026-11-30" };

  it("per-ad conversation list respects assigned visibility", async () => {
    const { svc } = build();
    const mine = await svc.conversations(WS1, "ad-1", { userId: ME }, RANGE);
    expect(mine.items.map((i) => i.conversationId)).toEqual(["cv-mine", "cv-mine"]);
    expect(mine.items[0]).toEqual({
      conversationId: "cv-mine",
      contactId: "ct-cv-mine",
      contactName: "Mine",
      channelId: "ch-1",
      referredAt: t(4),
      firstTouch: false,
      status: "human",
      assigneeId: ME,
    });
    expect(JSON.stringify(mine)).not.toContain("secret-clid");

    const all = await svc.conversations(WS1, "ad-1", { userId: "owner" }, RANGE);
    expect(all.items.map((i) => i.conversationId)).toEqual(["cv-other", "cv-mine", "cv-none", "cv-other", "cv-mine"]);
    // A bypass session (super-admin / impersonation) is unfiltered too.
    expect((await svc.conversations(WS1, "ad-1", { userId: "x", bypass: true }, RANGE)).items).toHaveLength(5);
    // A non-member fails closed.
    expect((await svc.conversations(WS1, "ad-1", { userId: "stranger" }, RANGE)).items).toEqual([]);
  });

  it("cursor paging is stable under a new touch", async () => {
    const { prisma, svc } = build();
    const p1 = await svc.conversations(WS1, "ad-1", { userId: "owner" }, { ...RANGE, limit: 2 });
    expect(p1.items.map((i) => i.referredAt)).toEqual([t(5), t(4)]);
    expect(p1.nextCursor).toEqual(expect.any(String));
    // A new, newer touch arrives between pages: it never shifts the next page.
    prisma.db.adReferral.push(touch("r9", "cv-none", 30));
    const p2 = await svc.conversations(WS1, "ad-1", { userId: "owner" }, { ...RANGE, limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((i) => i.referredAt)).toEqual([t(3), t(2)]);
    const p3 = await svc.conversations(WS1, "ad-1", { userId: "owner" }, { ...RANGE, limit: 2, cursor: p2.nextCursor! });
    expect(p3.items.map((i) => i.referredAt)).toEqual([t(1)]);
    expect(p3.nextCursor).toBeNull();
    await expect(svc.conversations(WS1, "ad-1", { userId: "owner" }, { ...RANGE, cursor: "%%%" })).rejects.toMatchObject({
      response: { message: "ads.range_invalid" },
    });
  });

  it("foreign ids return 404 on SP-15 routes", async () => {
    const { svc } = build();
    for (const id of ["ad-foreign", "missing"]) {
      await expect(svc.conversations(WS1, id, { userId: "owner" }, RANGE)).rejects.toMatchObject({
        status: 404,
        response: { statusCode: 404, message: "ads.not_found" },
      });
    }
  });
});

/**
 * SP-16 ruling 14: smart-audience rules over conversation data (last active,
 * channel, conversations) evaluate workspace-wide, so an assigned-only member
 * may learn that SOME contact matches. What the audience routes return must
 * still carry no conversation id, message text or assignee.
 */
describe("audience routes expose no conversation data", () => {
  it("the JSON of /segments/:id/contacts, the preview sample and the detail has no conversation id, message text or assignee", async () => {
    const t = predicateWorld();
    for (const cv of t.conversation) Object.assign(cv, { assigneeId: "agent-secret-7", lastMessage: "SECRET-CONVERSATION-TEXT" });
    for (const m of t.message) Object.assign(m, { text: "SECRET-MESSAGE-TEXT" });
    const fake = createAudienceDb(t);
    const svc = new SegmentsService(fake.prisma as never);
    const ctrl = new SegmentsController(fake.prisma as never, svc, { emitSegmentUpserted: jest.fn(), emitSegmentDeleted: jest.fn() } as never);
    const rules = {
      v: 2 as const,
      op: "or" as const,
      rules: [
        { field: "last_active" as const, op: "within" as const, value: { amount: 30, unit: "days" as const } },
        { field: "channel" as const, op: "is" as const, channel: "whatsapp" },
        { field: "conversations" as const, op: "any" as const },
      ],
    };
    const saved = await svc.save(SP16_WS, { name: "Talkers", rules });
    const page = await ctrl.contacts(SP16_WS, saved.id);
    const preview = await svc.preview(SP16_WS, { rules });
    const detail = await ctrl.detail(SP16_WS, saved.id);
    expect(page.items.length).toBeGreaterThan(0);
    expect(preview.sample.length).toBeGreaterThan(0);
    const json = JSON.stringify([page, preview, detail]);
    const convIds = t.conversation.map((c) => c.id);
    const msgIds = t.message.map((m) => m.id);
    for (const id of [...convIds, ...msgIds]) expect({ id, leaked: json.includes(`"${id}"`) }).toEqual({ id, leaked: false });
    for (const secret of ["agent-secret-7", "SECRET-CONVERSATION-TEXT", "SECRET-MESSAGE-TEXT", "assigneeId", "conversationId", "messages"]) {
      expect({ secret, leaked: json.includes(secret) }).toEqual({ secret, leaked: false });
    }
    // Only contact columns, in the documented page and sample shapes.
    for (const item of page.items) expect(Object.keys(item).sort()).toEqual(["email", "id", "lifecycle", "name", "phone"]);
    for (const s of preview.sample) expect(Object.keys(s).sort()).toEqual(["id", "name", "phone"]);
  });
});

/**
 * SP-09 (ruling 10, Review Focus 2): a ticket's customer files and its derived
 * channel follow the viewer's conversation visibility; the ticket itself and
 * its staff files follow tickets.view only.
 */
describe("SP-09 ticket attachments and channel follow conversation visibility", () => {
  const W = "ws-t";
  function build() {
    const prisma = makeFakePrisma({
      workspace: [{ id: W }],
      user: [{ id: "owner", name: "Owner" }, { id: ME, name: "Me" }],
      role: [
        { id: "r-owner", workspaceId: W, key: "owner", isSystem: true, name: "Owner", nameAr: "Owner", permissions: { "*": ["*"] }, conversationVisibility: "all" },
        { id: "r-assigned", workspaceId: W, key: null, isSystem: false, name: "A", nameAr: "A", permissions: { tickets: ["view", "update"], conversations: ["view"] }, conversationVisibility: "assigned" },
      ],
      workspaceMember: [
        { id: "wm1", workspaceId: W, userId: "owner", role: "owner", roleId: null },
        { id: "wm2", workspaceId: W, userId: ME, role: "custom", roleId: "r-assigned" },
      ],
      channel: [{ id: "ch-1", workspaceId: W, kind: "whatsapp", displayName: "Main line", provider: "zernio" }],
      conversation: [{ id: "cv-hidden", workspaceId: W, contactId: "ct", channel: "whatsapp", channelId: "ch-1", assigneeId: "someone" }],
      message: [{ id: "m1", workspaceId: W, conversationId: "cv-hidden", from: "them", body: "", t: "10:00", attach: "md-cust", createdAt: new Date() }],
      media: [
        { id: "md-cust", workspaceId: W, fileName: "c.jpg", mimeType: "image/jpeg", sizeBytes: 1, storedPath: "w/c.jpg", storageKind: "local", uploadedById: null, createdAt: new Date() },
        { id: "md-cand", workspaceId: W, fileName: "d.jpg", mimeType: "image/jpeg", sizeBytes: 1, storedPath: "w/d.jpg", storageKind: "local", uploadedById: null, createdAt: new Date() },
        { id: "md-staff", workspaceId: W, fileName: "s.png", mimeType: "image/png", sizeBytes: 1, storedPath: "w/s.png", storageKind: "local", uploadedById: "owner", createdAt: new Date() },
      ],
      ticket: [
        { id: "tk", workspaceId: W, number: 3, pipelineId: "pl", stageId: "st", contactId: "ct", conversationId: "cv-hidden", title: "T", priority: "normal", category: null, slaDueAt: null },
      ],
      ticketAttachment: [
        { id: "att-cust", workspaceId: W, ticketId: "tk", mediaId: "md-cust", source: "customer", messageId: "m1", addedById: "owner", createdAt: new Date() },
        { id: "att-staff", workspaceId: W, ticketId: "tk", mediaId: "md-staff", source: "staff", messageId: null, addedById: "owner", createdAt: new Date() },
      ],
    });
    prisma.db.message.push({ id: "m2", workspaceId: W, conversationId: "cv-hidden", from: "them", body: "", t: "10:01", attach: "md-cand", createdAt: new Date() });
    const perm = new PermissionService(prisma);
    const storage = { kind: "local", resolveAbsolute: jest.fn((p: string) => `/abs/${p}`), getSignedUrl: jest.fn(), put: jest.fn(), delete: jest.fn() };
    const media = new MediaService(prisma, storage as never, perm);
    const attachments = new TicketAttachmentsService(prisma, media, perm);
    const tickets = new TicketsService(prisma, { emitToWorkspace: jest.fn() } as never, undefined, undefined, perm);
    return { prisma, perm, storage, attachments, tickets };
  }
  const res = () => ({ setHeader: jest.fn(), sendFile: jest.fn(), destroy: jest.fn() });

  it("ticket attachment from a hidden conversation is 404 for an assigned-only agent", async () => {
    const { attachments, storage } = build();
    const me = { userId: ME };

    expect((await attachments.list(W, "tk", me)).items.map((a) => a.id)).toEqual(["att-staff"]);
    await expect(attachments.serve(W, "tk", "att-cust", res() as never, me)).rejects.toMatchObject({
      status: 404,
      response: { message: "tickets.attachment_not_found" },
    });
    await expect(attachments.unlink(W, "tk", "att-cust", me)).rejects.toBeInstanceOf(NotFoundException);
    expect(await attachments.candidates(W, "tk", me)).toEqual({ items: [] });
    await expect(attachments.attach(W, "tk", "md-cand", me)).rejects.toMatchObject({ status: 404 });
    expect(storage.resolveAbsolute).not.toHaveBeenCalledWith("w/c.jpg");

    // The staff file on the same ticket downloads (200: the bytes are sent).
    const ok = res();
    await attachments.serve(W, "tk", "att-staff", ok as never, me);
    expect(ok.sendFile).toHaveBeenCalledWith("/abs/w/s.png");

    // The owner (visibility "all") and a bypass session see both.
    expect((await attachments.list(W, "tk", { userId: "owner" })).items).toHaveLength(2);
    expect((await attachments.list(W, "tk", { userId: "x", bypass: true })).items).toHaveLength(2);
    expect((await attachments.candidates(W, "tk", { userId: "owner" })).items.map((c) => c.mediaId)).toEqual(["md-cand"]);
  });

  it("ticket channel is null when its conversation is hidden", async () => {
    const { tickets } = build();
    const mine: any = await tickets.getTicket(W, "tk", { userId: ME });
    expect(mine.channel).toBeNull();
    expect(mine.attachmentCount).toBe(1); // the hidden customer file is not counted
    const list: any = await tickets.listTickets(W, { view: "table" }, { userId: ME });
    expect(list.items[0]).toMatchObject({ channel: null, attachmentCount: 1 });

    const owner: any = await tickets.getTicket(W, "tk", { userId: "owner" });
    expect(owner.channel).toEqual({ kind: "whatsapp", channelId: "ch-1", displayName: "Main line" });
    expect(owner.attachmentCount).toBe(2);
    // A non-member fails closed.
    expect(((await tickets.getTicket(W, "tk", { userId: "stranger" })) as any).channel).toBeNull();
  });
});

/**
 * SP-11 Review Focus 1: an assigned-only member reads support insights only
 * over their own conversations, filtered inside every SQL statement (never
 * afterwards), so no count can reveal a hidden conversation.
 */
describe("SP-11 support insights", () => {
  function build(viewerVisibility: "assigned" | "all") {
    const prisma = makePrisma({ ...ASSIGNED_PERMS, reports: ["view"] }, viewerVisibility);
    const queried: Prisma.Sql[] = [];
    const tx = {
      $executeRawUnsafe: jest.fn(async () => 0),
      $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
        queried.push(sql);
        return [];
      }),
    };
    prisma.$transaction = jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
    prisma.workspace = { findUnique: jest.fn(async () => ({ timezone: "Asia/Riyadh", lang: "ar" })) };
    const perm = new PermissionService(prisma);
    return { svc: new InsightsService(prisma, perm), perm, queried };
  }
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it("support insights respect assigned visibility", async () => {
    const { svc, perm, queried } = build("assigned");
    await svc.support(WS, INSIGHTS_RANGE, viewer);
    expect(queried.length).toBeGreaterThanOrEqual(11);
    for (const sql of queried) {
      const text = sql.strings.join("?");
      const tag = /insights:support\.(\w+)/.exec(text)?.[1];
      // Every conversation the statement reads carries the viewer's scope…
      const reads = (text.match(/"Conversation" c\s/g) ?? []).length;
      expect({ tag, scoped: count(text, 'AND c."assigneeId" = ?') }).toEqual({ tag, scoped: reads });
      // …and the scope is the viewer, never anyone else.
      if (reads > 0) expect(sql.values.filter((v) => v === ME).length).toBeGreaterThanOrEqual(reads);
    }

    // The figures equal the world restricted to the agent's conversations
    // (expected values written by hand in insights-expected.ts).
    const scope = await perm.conversationScope(WS, { userId: INSIGHTS_U.assigned });
    expect(scope).toEqual({ assigneeId: INSIGHTS_U.assigned });
    const range = parseRange(INSIGHTS_RANGE.from, INSIGHTS_RANGE.to, "Asia/Riyadh", new Date("2026-11-10T09:00:00Z"));
    expect(supportOracle(INSIGHTS_WORLD, { range, scope, channelId: null })).toEqual(ASSIGNED);
  });

  it("a member who sees every conversation gets no assignee clause; a bypass session neither", async () => {
    for (const [visibility, v] of [
      ["all", viewer],
      ["assigned", { userId: ME, bypass: true }],
    ] as const) {
      const { svc, queried } = build(visibility);
      await svc.support(WS, INSIGHTS_RANGE, v);
      for (const sql of queried) expect(sql.strings.join("?")).not.toContain('"assigneeId" = ?');
    }
  });
});

/**
 * SP-11 Review Focus 1 (sales): replied, speed, waiting, the ad/channel of a
 * source and a rep's speed read only conversations the viewer may see, inside
 * the SQL; a hidden thread's customer message never makes a lead "waiting".
 */
describe("SP-11 sales insights", () => {
  function build(visibility: "assigned" | "all") {
    const prisma = makePrisma({ ...ASSIGNED_PERMS, reports: ["view"] }, visibility);
    const queried: Prisma.Sql[] = [];
    const tx = {
      $executeRawUnsafe: jest.fn(async () => 0),
      $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
        queried.push(sql);
        return [];
      }),
    };
    prisma.$transaction = jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
    prisma.workspace = { findUnique: jest.fn(async () => ({ timezone: "Asia/Riyadh", lang: "ar" })) };
    prisma.pipeline = { findFirst: jest.fn(async () => ({ id: "pl-leads", name: "Leads", nameAr: "Leads", kind: "leads" })) };
    const perm = new PermissionService(prisma);
    return { svc: new InsightsService(prisma, perm), perm, queried };
  }

  it("sales waiting ignores hidden threads", async () => {
    const { svc, perm, queried } = build("assigned");
    const res = await svc.sales(WS, SALES_RANGE, viewer, SALES_NOW);
    expect(res.headline.status).toBe("ok");
    expect(queried.length).toBe(12);
    for (const sql of queried) {
      const text = sql.strings.join("?");
      const tag = /insights:(\w+\.\w+)/.exec(text)?.[1];
      // Every conversation the statement reads carries the viewer's scope.
      const reads = (text.match(/"Conversation" c\s/g) ?? []).length;
      expect({ tag, scoped: (text.match(/AND c\."assigneeId" = \?/g) ?? []).length }).toEqual({ tag, scoped: reads });
      if (reads > 0) expect(sql.values.filter((v) => v === ME).length).toBeGreaterThanOrEqual(reads);
    }
    const waiting = queried.find((s) => s.strings[0].includes("insights:sales.waiting"))!;
    expect(waiting.strings.join("?")).toContain('AND c."assigneeId" = ?');

    // The figures: L6's customer message is on a conversation hidden from the
    // assigned-only agent, so the owner sees 3 waiting leads and he sees 0.
    const range = parseRange(SALES_RANGE.from, SALES_RANGE.to, "Asia/Riyadh", SALES_NOW);
    const scope = await perm.conversationScope(WS, { userId: INSIGHTS_U.assigned });
    const theirs = salesOracle(INSIGHTS_WORLD, { range, scope, pipelineId: "pl-leads", now: SALES_NOW });
    expect(theirs).toEqual(SALES_ASSIGNED);
    expect(theirs.headline.waiting).toBe(0);
    expect(salesOracle(INSIGHTS_WORLD, { range, scope: {}, pipelineId: "pl-leads", now: SALES_NOW }).headline.waiting).toBe(
      SALES_OWNER.headline.waiting,
    );
  });

  it("a member who sees every conversation gets no assignee clause in sales", async () => {
    const { svc, queried } = build("all");
    await svc.sales(WS, SALES_RANGE, viewer, SALES_NOW);
    for (const sql of queried) expect(sql.strings.join("?")).not.toContain('"assigneeId" = ?');
  });

  it("ticket sections are forbidden without tickets.view (real permissions)", async () => {
    const prisma = makePrisma({ reports: ["view"] }, "all");
    prisma.workspace = { findUnique: jest.fn(async () => ({ timezone: "Asia/Riyadh", lang: "ar" })) };
    prisma.pipeline = { findFirst: jest.fn(async () => ({ id: "pl-leads", name: "Leads", nameAr: "Leads", kind: "leads" })) };
    prisma.$transaction = jest.fn();
    const res = await new InsightsService(prisma, new PermissionService(prisma)).sales(WS, SALES_RANGE, viewer, SALES_NOW);
    expect(res.headline).toEqual({ status: "forbidden" });
    expect(res.reps).toEqual({ status: "forbidden" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
