import { BadRequestException, NotFoundException } from "@nestjs/common";
import { RecordsService } from "./records.service";
import { canOpenRecord } from "../notifications/record-access";

jest.mock("../notifications/record-access", () => ({ canOpenRecord: jest.fn() }));

const WS = "ws1";
const ME = { userId: "me" };
const created = new Date("2026-01-02T03:04:05.000Z");

describe("RecordsService", () => {
  let prisma: any;
  let perm: { conversationScope: jest.Mock };
  let svc: RecordsService;
  const canOpen = canOpenRecord as jest.Mock;

  beforeEach(() => {
    prisma = {
      contact: { findFirst: jest.fn().mockResolvedValue(null) },
      conversation: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      ticket: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      appointment: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      campaign: { findFirst: jest.fn().mockResolvedValue(null) },
      user: { findFirst: jest.fn().mockResolvedValue({ name: "Sara" }) },
    };
    perm = { conversationScope: jest.fn().mockResolvedValue({}) };
    canOpen.mockReset().mockResolvedValue(true);
    svc = new RecordsService(prisma, perm as never);
  });

  const contactRow = {
    id: "c1", name: "Layla", phone: "+966500", email: "l@x.com", lifecycle: "Customer",
    tags: '["vip","ksa"]', createdAt: created, owner: { name: "Omar" },
  };

  it("contact: fields and links (conversations, open tickets, upcoming bookings)", async () => {
    prisma.contact.findFirst.mockResolvedValue(contactRow);
    prisma.conversation.findMany.mockResolvedValue([{ id: "v1", channel: "whatsapp", updatedAt: created }]);
    prisma.ticket.findMany.mockResolvedValue([{ id: "t1", number: 12, title: "Refund", stage: { label: "New", labelAr: "جديد" } }]);
    prisma.appointment.findMany.mockResolvedValue([{ id: "b1", service: "Cut", serviceAr: "قص", startAt: created }]);
    const r = await svc.get(WS, ME, "contact", "c1");
    expect(r).toMatchObject({ kind: "contact", id: "c1", title: "Layla", subtitle: "+966500" });
    expect(r.fields).toEqual([
      { key: "lifecycle", value: "Customer" },
      { key: "phone", value: "+966500" },
      { key: "email", value: "l@x.com" },
      { key: "owner", value: "Omar" },
      { key: "tags", value: "vip, ksa" },
      { key: "createdAt", value: created.toISOString() },
    ]);
    expect(r.links).toEqual([
      { kind: "conversation", id: "v1", title: "Layla", subtitle: "whatsapp", updatedAt: created.toISOString() },
      { kind: "ticket", id: "t1", title: "#12 · Refund", subtitle: "New", subtitleAr: "جديد" },
      { kind: "booking", id: "b1", title: "Cut", titleAr: "قص", subtitle: created.toISOString() },
    ]);
    const tq = prisma.ticket.findMany.mock.calls[0][0];
    expect(tq.where).toMatchObject({ closedAt: null, workspaceId: WS });
    expect(tq.take).toBe(5);
    const bq = prisma.appointment.findMany.mock.calls[0][0];
    expect(bq.where.startAt.gte).toBeInstanceOf(Date);
    expect(bq.take).toBe(5);
  });

  it("conversation: fields, contact and ticket links", async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: "v1", channel: "whatsapp", status: "human", escalated: true, lastAt: "2m", updatedAt: created,
      contact: { id: "c1", name: "Layla", phone: null }, assignee: { name: "Omar" },
    });
    prisma.ticket.findMany.mockResolvedValue([{ id: "t1", number: 3, title: "X", stage: { label: "Won" } }]);
    const r = await svc.get(WS, ME, "conversation", "v1");
    expect(r).toMatchObject({ title: "Layla", subtitle: "whatsapp" });
    expect(r.fields).toEqual([
      { key: "channel", value: "whatsapp" },
      { key: "status", value: "human" },
      { key: "assignee", value: "Omar" },
      { key: "escalated", value: true },
      { key: "lastAt", value: "2m" },
      { key: "updatedAt", value: created.toISOString() },
    ]);
    expect(r.links.map((l) => `${l.kind}:${l.id}`)).toEqual(["contact:c1", "ticket:t1"]);
    expect(prisma.ticket.findMany.mock.calls[0][0].where).toMatchObject({ conversationId: "v1" });
  });

  it("ticket: fields, contact and DB-conversation links", async () => {
    prisma.ticket.findFirst.mockResolvedValue({
      id: "t1", number: 12, title: "Refund", value: 250, ownerId: "u9", conversationId: "v1", createdAt: created,
      pipeline: { name: "Retail" }, stage: { label: "New", labelAr: "جديد" }, contact: { id: "c1", name: "Layla", phone: "+9665" },
    });
    prisma.conversation.findFirst.mockResolvedValue({ id: "v1", channel: "instagram", updatedAt: created });
    const r = await svc.get(WS, ME, "ticket", "t1");
    expect(r).toMatchObject({ title: "#12 · Refund", subtitle: "Layla" });
    expect(r.fields).toEqual([
      { key: "number", value: 12 },
      { key: "pipeline", value: "Retail" },
      { key: "stage", value: "New" },
      { key: "stageAr", value: "جديد" },
      { key: "value", value: 250 },
      { key: "owner", value: "Sara" },
      { key: "createdAt", value: created.toISOString() },
    ]);
    expect(r.links.map((l) => `${l.kind}:${l.id}`)).toEqual(["contact:c1", "conversation:v1"]);
    expect(r.links[1].updatedAt).toBe(created.toISOString());
  });

  it("ticket: opaque conversation id yields no conversation link", async () => {
    prisma.ticket.findFirst.mockResolvedValue({
      id: "t1", number: 1, title: "T", value: null, ownerId: null, conversationId: "t_fb123", createdAt: created,
      pipeline: { name: "P" }, stage: { label: "S" }, contact: { id: "c1", name: "L", phone: null },
    });
    const r = await svc.get(WS, ME, "ticket", "t1");
    expect(r.links.map((l) => l.kind)).toEqual(["contact"]);
  });

  it("ticket: conversation link dropped when the viewer cannot open it", async () => {
    prisma.ticket.findFirst.mockResolvedValue({
      id: "t1", number: 1, title: "T", value: null, ownerId: null, conversationId: "v1", createdAt: created,
      pipeline: { name: "P" }, stage: { label: "S" }, contact: { id: "c1", name: "L", phone: null },
    });
    prisma.conversation.findFirst.mockResolvedValue({ id: "v1", channel: "whatsapp", updatedAt: created });
    canOpen.mockImplementation(async (_p, _w, _u, kind) => kind !== "conversation");
    const r = await svc.get(WS, ME, "ticket", "t1");
    expect(r.links.map((l) => l.kind)).toEqual(["contact"]);
  });

  it("booking: fields and contact link", async () => {
    prisma.appointment.findFirst.mockResolvedValue({
      id: "b1", service: "Cut", serviceAr: "قص", startAt: created, status: "confirmed", staffId: "u2",
      contact: { id: "c1", name: "Layla", phone: null },
    });
    const r = await svc.get(WS, ME, "booking", "b1");
    expect(r).toMatchObject({ kind: "booking", title: "Cut", titleAr: "قص", subtitle: "Layla" });
    expect(r.fields).toEqual([
      { key: "service", value: "Cut" },
      { key: "serviceAr", value: "قص" },
      { key: "start", value: created.toISOString() },
      { key: "status", value: "confirmed" },
      { key: "staff", value: "Sara" },
    ]);
    expect(r.links).toEqual([{ kind: "contact", id: "c1", title: "Layla" }]);
  });

  it("Arabic keys are omitted/null when no Arabic value exists", async () => {
    prisma.appointment.findFirst.mockResolvedValue({
      id: "b1", service: "Cut", serviceAr: "", startAt: created, status: "confirmed", staffId: null,
      contact: { id: "c1", name: "Layla", phone: null },
    });
    const r = await svc.get(WS, ME, "booking", "b1");
    expect(r).not.toHaveProperty("titleAr");
    expect(r.fields).toContainEqual({ key: "serviceAr", value: null });
  });

  it("campaign: fields and no links", async () => {
    prisma.campaign.findFirst.mockResolvedValue({
      id: "cp1", name: "Eid", channel: "Broadcast", status: "completed", sent: 10, delivered: 9, read: 5, failed: 1,
    });
    const r = await svc.get(WS, ME, "campaign", "cp1");
    expect(r).toMatchObject({ title: "Eid", subtitle: "Broadcast", links: [] });
    expect(r.fields).toEqual([
      { key: "status", value: "completed" },
      { key: "sent", value: 10 },
      { key: "delivered", value: 9 },
      { key: "read", value: 5 },
      { key: "failed", value: 1 },
    ]);
  });

  it("foreign workspace id -> 404 (canOpenRecord scoped to the workspace)", async () => {
    canOpen.mockResolvedValue(false);
    await expect(svc.get("other-ws", ME, "contact", "c1")).rejects.toThrow(NotFoundException);
    expect(canOpen).toHaveBeenCalledWith(prisma, "other-ws", "me", "contact", "c1", perm);
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  it("assigned-only viewer: hidden conversation -> 404", async () => {
    canOpen.mockImplementation(async (_p, _w, _u, kind, id) => !(kind === "conversation" && id === "hidden"));
    await expect(svc.get(WS, ME, "conversation", "hidden")).rejects.toThrow(NotFoundException);
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
  });

  it("missing view permission -> 404", async () => {
    canOpen.mockImplementation(async (_p, _w, _u, kind) => kind !== "campaign");
    await expect(svc.get(WS, ME, "campaign", "cp1")).rejects.toThrow(NotFoundException);
    expect(prisma.campaign.findFirst).not.toHaveBeenCalled();
  });

  it("allowed but row vanished -> 404", async () => {
    await expect(svc.get(WS, ME, "contact", "gone")).rejects.toThrow(NotFoundException);
  });

  it("contact links omit hidden conversations (scope applied and per-link check)", async () => {
    const scope = { assigneeId: "me" };
    perm.conversationScope.mockResolvedValue(scope);
    prisma.contact.findFirst.mockResolvedValue(contactRow);
    prisma.conversation.findMany.mockResolvedValue([
      { id: "mine", channel: "whatsapp", updatedAt: created },
      { id: "hidden", channel: "whatsapp", updatedAt: created },
    ]);
    canOpen.mockImplementation(async (_p, _w, _u, kind, id) => !(kind === "conversation" && id === "hidden"));
    const r = await svc.get(WS, ME, "contact", "c1");
    expect(r.links.map((l) => l.id)).toEqual(["mine"]);
    expect(prisma.conversation.findMany.mock.calls[0][0].where).toMatchObject(scope);
  });

  it("contact links omit kinds the viewer cannot view (tickets)", async () => {
    prisma.contact.findFirst.mockResolvedValue(contactRow);
    prisma.ticket.findMany.mockResolvedValue([{ id: "t1", number: 1, title: "T", stage: { label: "S" } }]);
    canOpen.mockImplementation(async (_p, _w, _u, kind) => kind !== "ticket");
    const r = await svc.get(WS, ME, "contact", "c1");
    expect(r.links).toEqual([]);
  });

  it("unknown kind -> 400 before any lookup", async () => {
    await expect(svc.get(WS, ME, "bogus", "1")).rejects.toThrow(BadRequestException);
    expect(canOpen).not.toHaveBeenCalled();
  });

  it("bypass viewer (super-admin/impersonation): existence in workspace only", async () => {
    const bypass = { userId: "sa", bypass: true };
    prisma.campaign.findFirst.mockResolvedValue({
      id: "cp1", name: "Eid", channel: "Broadcast", status: "draft", sent: 0, delivered: 0, read: 0, failed: 0,
    });
    const r = await svc.get(WS, bypass, "campaign", "cp1");
    expect(r.id).toBe("cp1");
    expect(canOpen).not.toHaveBeenCalled();
    expect(prisma.campaign.findFirst.mock.calls[0][0].where).toEqual({ id: "cp1", workspaceId: WS });
    prisma.campaign.findFirst.mockResolvedValue(null);
    await expect(svc.get(WS, bypass, "campaign", "zz")).rejects.toThrow(NotFoundException);
  });
});
