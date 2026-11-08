import { ConflictException, NotFoundException } from "@nestjs/common";
import { ConversationLabelsService } from "./conversation-labels.service";

describe("ConversationLabelsService", () => {
  let prisma: any;
  let realtime: { emitToWorkspace: jest.Mock };
  let svc: ConversationLabelsService;

  beforeEach(() => {
    prisma = {
      conversationLabel: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversationLabelLink: {
        count: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      conversation: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
    };
    realtime = { emitToWorkspace: jest.fn() };
    svc = new ConversationLabelsService(prisma as never, realtime as never);
  });

  it("lists with counts", async () => {
    prisma.conversationLabel.findMany.mockResolvedValue([
      { id: "l1", name: "VIP", color: "ok", _count: { links: 3 } },
    ]);
    const res = await svc.list("ws1");
    expect(prisma.conversationLabel.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws1" });
    expect(res).toEqual([{ id: "l1", name: "VIP", color: "ok", count: 3 }]);
  });

  it("rejects duplicate name with 409", async () => {
    prisma.conversationLabel.create.mockRejectedValue({ code: "P2002" });
    const err = await svc.create("ws1", { name: " VIP ", color: "ok" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe("label exists");
    expect(prisma.conversationLabel.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: "ws1",
      name: "VIP",
    });
  });

  it("delete reports unlinked count", async () => {
    prisma.conversationLabel.findFirst.mockResolvedValue({ id: "l1" });
    prisma.conversationLabelLink.count.mockResolvedValue(4);
    const res = await svc.remove("ws1", "l1");
    expect(res).toEqual({ ok: true, unlinked: 4 });
    expect(prisma.conversationLabel.deleteMany).toHaveBeenCalledWith({
      where: { id: "l1", workspaceId: "ws1" },
    });
  });

  it("set labels replaces the set", async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: "cv1", channel: "whatsapp" });
    prisma.conversationLabel.findMany.mockResolvedValue([{ id: "l1" }, { id: "l2" }]);
    const res = await svc.setForConversation("ws1", "cv1", ["l1", "l2", "l1"]);
    expect(res).toEqual({ labelIds: ["l1", "l2"] });
    expect(prisma.conversationLabel.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: "ws1",
      id: { in: ["l1", "l2"] },
    });
    expect(prisma.conversationLabelLink.deleteMany).toHaveBeenCalledWith({
      where: { conversationId: "cv1", labelId: { notIn: ["l1", "l2"] } },
    });
    expect(prisma.conversationLabelLink.createMany).toHaveBeenCalledWith({
      data: [
        { conversationId: "cv1", labelId: "l1" },
        { conversationId: "cv1", labelId: "l2" },
      ],
      skipDuplicates: true,
    });
    expect(prisma.conversation.update.mock.calls[0][0].data.version).toEqual({ increment: 1 });
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "inbox.activity", {
      channel: "whatsapp",
      conversationId: "cv1",
    });
  });

  it("foreign label id -> 404", async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: "cv1", channel: "whatsapp" });
    prisma.conversationLabel.findMany.mockResolvedValue([{ id: "l1" }]);
    await expect(svc.setForConversation("ws1", "cv1", ["l1", "evil"])).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("foreign conversation -> 404", async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(svc.setForConversation("ws1", "cvX", ["l1"])).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.conversationLabelLink.deleteMany).not.toHaveBeenCalled();
  });
});
