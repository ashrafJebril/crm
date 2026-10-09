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
  const svc = new LWebhooksService(prisma as unknown as PrismaService);
  return { svc, prisma };
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
