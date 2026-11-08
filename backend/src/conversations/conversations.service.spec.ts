import { readFileSync } from "fs";
import { join } from "path";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { ConversationsService } from "./conversations.service";

describe("ConversationsService.update", () => {
  const baseRow = (over: Record<string, unknown> = {}) => ({
    id: "cv1",
    workspaceId: "ws1",
    channel: "whatsapp",
    status: "human",
    escalated: false,
    escalateReason: null,
    assigneeId: null,
    version: 3,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    labels: [{ labelId: "l1" }],
    ...over,
  });

  let prisma: {
    conversation: { findFirst: jest.Mock; updateMany: jest.Mock };
    workspaceMember: { findFirst: jest.Mock };
  };
  let realtime: { emitToWorkspace: jest.Mock };
  let svc: ConversationsService;

  beforeEach(() => {
    prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(baseRow()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      workspaceMember: { findFirst: jest.fn().mockResolvedValue({ userId: "u1" }) },
    };
    realtime = { emitToWorkspace: jest.fn() };
    svc = new ConversationsService(
      prisma as never,
      realtime as never,
      { queueReply: jest.fn() } as never,
    );
  });

  const dataOf = () => prisma.conversation.updateMany.mock.calls[0][0].data;

  it("sets status, bumps version and stamps statusChangedAt", async () => {
    const res = await svc.update("ws1", "cv1", { status: "resolved", version: 3 });
    const call = prisma.conversation.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "cv1", workspaceId: "ws1", version: 3 });
    expect(call.data.status).toBe("resolved");
    expect(call.data.version).toEqual({ increment: 1 });
    expect(call.data.statusChangedAt).toBeInstanceOf(Date);
    expect(res.labelIds).toEqual(["l1"]);
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "inbox.activity", {
      channel: "whatsapp",
      conversationId: "cv1",
    });
  });

  it("keeps updatedAt unchanged so ownership actions do not reorder the inbox", async () => {
    await svc.update("ws1", "cv1", { assigneeId: null });
    expect(dataOf().updatedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  it("returns 409 with current when version is stale", async () => {
    const err = await svc.update("ws1", "cv1", { status: "closed", version: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().current.version).toBe(3);
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("returns 409 when the guarded write matches no row", async () => {
    prisma.conversation.updateMany.mockResolvedValue({ count: 0 });
    prisma.conversation.findFirst
      .mockResolvedValueOnce(baseRow())
      .mockResolvedValueOnce(baseRow({ version: 4 }));
    const err = await svc.update("ws1", "cv1", { status: "closed" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().current.version).toBe(4);
  });

  it("rejects an assignee who is not a member", async () => {
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    await expect(svc.update("ws1", "cv1", { assigneeId: "x" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.workspaceMember.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws1", userId: "x" },
    });
  });

  it("unassigns with null", async () => {
    prisma.conversation.findFirst.mockResolvedValue(baseRow({ assigneeId: "u1" }));
    await svc.update("ws1", "cv1", { assigneeId: null });
    expect(dataOf().assigneeId).toBeNull();
    expect(prisma.workspaceMember.findFirst).not.toHaveBeenCalled();
  });

  it("escalating requires a reason", async () => {
    await expect(svc.update("ws1", "cv1", { escalated: true })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      svc.update("ws1", "cv1", { escalated: true, escalateReason: "  " }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await svc.update("ws1", "cv1", { escalated: true, escalateReason: "angry" });
    expect(dataOf().escalated).toBe(true);
    expect(dataOf().escalateReason).toBe("angry");
  });

  it("validates escalation before the version check and assignee lookup", async () => {
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    const err = await svc
      .update("ws1", "cv1", { escalated: true, assigneeId: "x", version: 1 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/escalateReason/);
    expect(prisma.workspaceMember.findFirst).not.toHaveBeenCalled();
  });

  it("re-escalating an escalated thread keeps its reason", async () => {
    prisma.conversation.findFirst.mockResolvedValue(
      baseRow({ escalated: true, escalateReason: "angry" }),
    );
    await svc.update("ws1", "cv1", { escalated: true });
    expect(dataOf().escalated).toBe(true);
    expect(dataOf().escalateReason).toBe("angry");
  });

  it("de-escalating clears the reason", async () => {
    await svc.update("ws1", "cv1", { escalated: false });
    expect(dataOf().escalated).toBe(false);
    expect(dataOf().escalateReason).toBeNull();
  });

  it("404 for a conversation in another workspace", async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(svc.update("ws2", "cv1", { status: "closed" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe("assignment notifications", () => {
    let notifications: { notify: jest.Mock };
    let nsvc: ConversationsService;

    beforeEach(() => {
      notifications = { notify: jest.fn().mockResolvedValue(1) };
      (prisma as any).contact = { findFirst: jest.fn().mockResolvedValue({ name: "محمد أحمد" }) };
      prisma.conversation.findFirst.mockResolvedValue(baseRow({ contactId: "c1" }));
      nsvc = new ConversationsService(
        prisma as never,
        realtime as never,
        { queueReply: jest.fn() } as never,
        notifications as never,
      );
    });

    it("assignment produces a notification for the assignee, not the actor", async () => {
      await nsvc.update("ws1", "cv1", { assigneeId: "u2" }, "actor");
      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith("ws1", ["u2"], {
        type: "assignment",
        title: "assignment.conversation",
        body: JSON.stringify({ contactName: "محمد أحمد" }),
        recordKind: "conversation",
        recordId: "cv1",
        actorId: "actor",
      });
    });

    it("assigning to yourself or leaving the assignee unchanged does not notify the assignee", async () => {
      prisma.workspaceMember.findFirst.mockResolvedValue({ userId: "actor" });
      await nsvc.update("ws1", "cv1", { assigneeId: "actor" }, "actor");
      prisma.conversation.findFirst.mockResolvedValue(baseRow({ contactId: "c1", assigneeId: "u2" }));
      prisma.workspaceMember.findFirst.mockResolvedValue({ userId: "u2" });
      await nsvc.update("ws1", "cv1", { assigneeId: "u2" }, "actor");
      await nsvc.update("ws1", "cv1", { assigneeId: null }, "actor");
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it("a notification failure never breaks the update", async () => {
      notifications.notify.mockRejectedValue(new Error("boom"));
      await expect(nsvc.update("ws1", "cv1", { assigneeId: "u2" }, "actor")).resolves.toBeDefined();
    });

    it("does not notify when the version check fails", async () => {
      await expect(nsvc.update("ws1", "cv1", { assigneeId: "u2", version: 99 }, "actor")).rejects.toBeInstanceOf(ConflictException);
      expect(notifications.notify).not.toHaveBeenCalled();
    });
  });

  it("reopen trigger SQL covers pending_customer, resolved and closed, not spam, and ignores backfill", () => {
    const sql = readFileSync(
      join(__dirname, "../../prisma/migrations/20261108120000_conversation_ownership/migration.sql"),
      "utf8",
    );
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION conversation_reopen_on_inbound"));
    const m = fn.match(/"status" IN \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const list = m![1].split(",").map((x) => x.trim().replace(/'/g, ""));
    expect(list).toEqual(["pending_customer", "resolved", "closed"]);
    expect(list).not.toContain("spam");
    expect(fn).toContain(
      `AND ("statusChangedAt" IS NULL OR NEW."createdAt" >= "statusChangedAt")`,
    );
  });
});
