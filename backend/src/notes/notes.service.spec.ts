import { BadRequestException, NotFoundException } from "@nestjs/common";
import { NotesService } from "./notes.service";
import { canOpenRecord } from "../notifications/record-access";

jest.mock("../notifications/record-access", () => ({ canOpenRecord: jest.fn() }));

describe("NotesService", () => {
  let prisma: any;
  let notifications: { notify: jest.Mock };
  let svc: NotesService;
  const canOpen = canOpenRecord as jest.Mock;

  beforeEach(() => {
    prisma = {
      contact: { findFirst: jest.fn().mockResolvedValue({ id: "c1" }) },
      conversation: { findFirst: jest.fn().mockResolvedValue(null) },
      ticket: { findFirst: jest.fn().mockResolvedValue({ id: "t1" }) },
      note: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "n1", ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "n1", ...data })),
      },
      workspaceMember: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findUnique: jest.fn().mockResolvedValue({ name: "Sara" }) },
      noteSeen: { upsert: jest.fn().mockResolvedValue({}) },
    };
    notifications = { notify: jest.fn().mockResolvedValue(1) };
    canOpen.mockReset().mockResolvedValue(true);
    svc = new NotesService(prisma, notifications as never);
  });

  it("reply to a reply -> 400", async () => {
    prisma.note.findFirst.mockResolvedValue({ id: "p", contactId: "c1", parentId: "root" });
    await expect(svc.create("ws", { contactId: "c1", body: "x", parentId: "p" }, "me")).rejects.toThrow(BadRequestException);
  });

  it("reply on another contact -> 400", async () => {
    prisma.note.findFirst.mockResolvedValue({ id: "p", contactId: "other", parentId: null });
    await expect(svc.create("ws", { contactId: "c1", body: "x", parentId: "p" }, "me")).rejects.toThrow("replies are one level");
  });

  it("reply with unknown parent -> 400", async () => {
    await expect(svc.create("ws", { contactId: "c1", body: "x", parentId: "zz" }, "me")).rejects.toThrow(BadRequestException);
  });

  it("valid reply stores parentId", async () => {
    prisma.note.findFirst.mockResolvedValue({ id: "p", contactId: "c1", parentId: null });
    await svc.create("ws", { contactId: "c1", body: "x", parentId: "p" }, "me");
    expect(prisma.note.create.mock.calls[0][0].data.parentId).toBe("p");
  });

  it("mention of non-member returns warning and does not notify", async () => {
    const res = await svc.create("ws", { contactId: "c1", body: "hi @[Ghost](user:ghost)" }, "me");
    expect(res.warnings).toEqual([{ userId: "ghost", reason: "not_a_member" }]);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(res.mentions).toEqual([]);
  });

  it("mention notifies member, not the author", async () => {
    prisma.workspaceMember.findMany.mockResolvedValue([{ userId: "u2" }, { userId: "me" }]);
    const res = await svc.create(
      "ws",
      { contactId: "c1", ticketId: "t1", body: "@[محمد](user:u2) @[Me](user:me) @[محمد](user:u2)" },
      "me",
    );
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const [ws, ids, payload] = notifications.notify.mock.calls[0];
    expect(ws).toBe("ws");
    expect(ids).toEqual(["u2"]);
    expect(payload).toMatchObject({
      type: "mention",
      title: "mention.note",
      recordKind: "ticket",
      recordId: "t1",
      actorId: "me",
    });
    expect(JSON.parse(payload.body)).toEqual({ excerpt: "@محمد @Me @محمد", actorName: "Sara" });
    expect(res.warnings).toEqual([]);
    expect(res.mentions).toEqual(["u2", "me"]);
  });

  it("opaque FB conversation id falls back to contact (no no_access warning, recordKind contact)", async () => {
    prisma.workspaceMember.findMany.mockResolvedValue([{ userId: "u2" }]);
    const res = await svc.create("ws", { contactId: "c1", conversationId: "t_123", body: "@[A](user:u2)" }, "me");
    expect(res.warnings).toEqual([]);
    expect(canOpen).toHaveBeenCalledWith(prisma, "ws", "u2", "contact", "c1");
    expect(notifications.notify.mock.calls[0][2]).toMatchObject({ recordKind: "contact", recordId: "c1" });
  });

  it("foreign ticket id falls back to contact", async () => {
    prisma.ticket.findFirst.mockResolvedValue(null);
    prisma.workspaceMember.findMany.mockResolvedValue([{ userId: "u2" }]);
    const note = { conversationId: null, ticketId: "tx", contactId: "c1", mentions: [], id: "n1" };
    prisma.note.findFirst.mockResolvedValue(note);
    await svc.update("ws", "n1", { body: "@[A](user:u2)" }, "me");
    expect(notifications.notify.mock.calls[0][2]).toMatchObject({ recordKind: "contact", recordId: "c1" });
  });

  it("create with a foreign ticketId -> 404 and nothing stored", async () => {
    prisma.ticket.findFirst.mockResolvedValue(null);
    await expect(svc.create("ws", { contactId: "c1", ticketId: "tx", body: "x" }, "me")).rejects.toThrow("Ticket not found");
    expect(prisma.note.create).not.toHaveBeenCalled();
  });

  it("no notification when the create fails", async () => {
    prisma.workspaceMember.findMany.mockResolvedValue([{ userId: "u2" }]);
    prisma.note.create.mockRejectedValue(new Error("db"));
    await expect(svc.create("ws", { contactId: "c1", body: "@[A](user:u2)" }, "me")).rejects.toThrow("db");
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("no_access mention warns and is not notified", async () => {
    prisma.workspaceMember.findMany.mockResolvedValue([{ userId: "u2" }]);
    canOpen.mockResolvedValue(false);
    const res = await svc.create("ws", { contactId: "c1", body: "@[A](user:u2)" }, "me");
    expect(res.warnings).toEqual([{ userId: "u2", reason: "no_access" }]);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("edit notifies only newly added mentions", async () => {
    prisma.note.findFirst.mockResolvedValue({
      id: "n1", contactId: "c1", conversationId: "cv1", ticketId: null, mentions: ["u2"], body: "old",
    });
    prisma.conversation.findFirst.mockResolvedValue({ id: "cv1" });
    prisma.workspaceMember.findMany.mockResolvedValue([{ userId: "u2" }, { userId: "u3" }]);
    await svc.update("ws", "n1", { body: "@[A](user:u2) @[B](user:u3)" }, "me");
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const [, ids, payload] = notifications.notify.mock.calls[0];
    expect(ids).toEqual(["u3"]);
    expect(payload).toMatchObject({ recordKind: "conversation", recordId: "cv1" });
    expect(prisma.note.update.mock.calls[0][0].data.mentions).toEqual(["u2", "u3"]);
  });

  it("list nests replies and seenBy", async () => {
    prisma.note.findMany.mockResolvedValue([{ id: "n1", replies: [], seenBy: [] }]);
    const rows = await svc.listForContact("ws", "c1");
    expect(rows).toHaveLength(1);
    const arg = prisma.note.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ workspaceId: "ws", contactId: "c1", parentId: null });
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
    expect(arg.include.replies.orderBy).toEqual({ createdAt: "asc" });
    expect(arg.include.replies.include.seenBy).toBeDefined();
    expect(arg.include.seenBy).toBeDefined();
  });

  it("seen is idempotent", async () => {
    prisma.note.findFirst.mockResolvedValue({ id: "n1" });
    await svc.markSeen("ws", "n1", "u1");
    await svc.markSeen("ws", "n1", "u1");
    expect(prisma.noteSeen.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.noteSeen.upsert.mock.calls[0][0]).toMatchObject({
      where: { noteId_userId: { noteId: "n1", userId: "u1" } },
      update: {},
    });
  });

  it("foreign note -> 404", async () => {
    await expect(svc.markSeen("ws", "x", "u1")).rejects.toThrow(NotFoundException);
    expect(prisma.noteSeen.upsert).not.toHaveBeenCalled();
    await expect(svc.update("ws", "x", { body: "y" }, "me")).rejects.toThrow(NotFoundException);
  });
});
