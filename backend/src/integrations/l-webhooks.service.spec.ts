import { LWebhooksService } from "./l-webhooks.service";
import { PrismaService } from "../prisma/prisma.service";

const BASE_BODY = {
  workspaceId: "l-ws-1",
  conversationId: "l-conv-1",
  agentId: "agent-1",
  userId: "user-1",
  message: "here you go",
  timestamp: "2026-10-09T00:00:00Z",
};

function build() {
  const prisma: any = {
    // handle() issues exactly two $queryRaw calls, in this order: the
    // workspace lookup by lWorkspaceId, then the existing-conversation
    // lookup by lConversationId. Mocked by call order rather than by
    // inspecting the SQL text, since the real call site passes a tagged
    // template, not a plain string.
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([{ id: "crm-ws-1" }])
      .mockResolvedValueOnce([]),
    contact: { upsert: jest.fn().mockResolvedValue({ id: "contact-1" }) },
    conversation: {
      create: jest.fn().mockResolvedValue({ id: "conv-1" }),
      update: jest.fn(),
    },
    $executeRaw: jest.fn(),
    message: { create: jest.fn().mockResolvedValue({}) },
  };
  const gate = { allows: jest.fn().mockResolvedValue(true) };
  const realtime = { emitToWorkspace: jest.fn() };
  const usage = { record: jest.fn() };
  const svc = new LWebhooksService(
    prisma as unknown as PrismaService, gate as never, realtime as never, usage as never,
  );
  return { svc, prisma, gate, realtime, usage };
}

describe("LWebhooksService.handle", () => {
  it("stores the image url in attach when the payload carries one", async () => {
    const { svc, prisma } = build();

    await svc.handle({
      event: "message.created",
      data: { ...BASE_BODY, imageUrl: "https://example.com/pic.png" },
    } as never);

    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attach: "https://example.com/pic.png" }),
      }),
    );
  });

  it("stores a null attach when the payload carries no image", async () => {
    const { svc, prisma } = build();

    await svc.handle({ event: "message.created", data: BASE_BODY } as never);

    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attach: null }),
      }),
    );
  });
});

describe("LWebhooksService.handle message.received", () => {
  it("stores a held customer message as theirs, unread, and tells the inbox", async () => {
    const { svc, prisma, realtime, usage } = build();

    await svc.handle({ event: "message.received", data: { ...BASE_BODY, message: "anyone there?" } } as never);

    const msg = prisma.message.create.mock.calls[0][0].data;
    expect(msg.from).toBe("them");
    expect(msg.body).toBe("anyone there?");
    expect(msg.agent).toBeUndefined();
    expect(prisma.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastFrom: "them", unread: 1 }) }),
    );
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("crm-ws-1", "inbox.activity", {
      channel: "l",
      conversationId: "conv-1",
    });
    // It is not an AI reply, so it is not metered as one.
    expect(usage.record).not.toHaveBeenCalled();
  });

  it("bumps unread on an existing conversation", async () => {
    const { svc, prisma } = build();
    prisma.$queryRaw = jest.fn().mockResolvedValueOnce([{ id: "crm-ws-1" }]).mockResolvedValueOnce([{ id: "conv-9" }]);

    await svc.handle({ event: "message.received", data: BASE_BODY } as never);

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conv-9" },
      data: expect.objectContaining({ lastFrom: "them", unread: { increment: 1 } }),
    });
  });

  it("still stores an agent answer as the AI's and meters it", async () => {
    const { svc, prisma, realtime, usage } = build();

    await svc.handle({ event: "message.created", data: BASE_BODY } as never);

    const msg = prisma.message.create.mock.calls[0][0].data;
    expect(msg.from).toBe("ai");
    expect(msg.agent).toBe("agent-1");
    expect(usage.record).toHaveBeenCalled();
    expect(realtime.emitToWorkspace).not.toHaveBeenCalled();
  });
});

describe("LWebhooksService.shouldReply", () => {
  const ASK = {
    workspaceId: "l-ws-1", conversationId: "l-conv-1", agentId: "agent-1", userId: "user-1", message: "hi",
  };

  function withRows(workspace: unknown[], conversation: unknown[], contact: unknown = null) {
    const t = build();
    t.prisma.$queryRaw = jest.fn().mockResolvedValueOnce(workspace).mockResolvedValueOnce(conversation);
    t.prisma.contact.findUnique = jest.fn().mockResolvedValue(contact);
    return t;
  }

  it("asks the gate about the linked conversation and its contact", async () => {
    const { svc, gate } = withRows([{ id: "crm-ws-1" }], [{ id: "conv-9", contactId: "contact-9" }]);
    gate.allows.mockResolvedValue(false);

    await expect(svc.shouldReply(ASK as never)).resolves.toEqual({ reply: false });
    expect(gate.allows).toHaveBeenCalledWith("crm-ws-1", { conversationId: "conv-9", contactId: "contact-9" }, "l_origin");
  });

  it("checks a first turn by the contact alone", async () => {
    const { svc, gate } = withRows([{ id: "crm-ws-1" }], [], { id: "contact-3" });

    await expect(svc.shouldReply(ASK as never)).resolves.toEqual({ reply: true });
    expect(gate.allows).toHaveBeenCalledWith("crm-ws-1", { conversationId: null, contactId: "contact-3" }, "l_origin");
  });

  it("checks a brand-new customer by the workspace rules only", async () => {
    const { svc, gate } = withRows([{ id: "crm-ws-1" }], [], null);

    await svc.shouldReply(ASK as never);
    expect(gate.allows).toHaveBeenCalledWith("crm-ws-1", { conversationId: null, contactId: null }, "l_origin");
  });

  it("does not gate a workspace that is not linked here", async () => {
    const { svc, gate } = withRows([], []);

    await expect(svc.shouldReply(ASK as never)).resolves.toEqual({ reply: true });
    expect(gate.allows).not.toHaveBeenCalled();
  });
});
