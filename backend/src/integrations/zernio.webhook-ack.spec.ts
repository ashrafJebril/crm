import { AiBridgeService } from "./ai-bridge.service";
import { ZernioService } from "./zernio.service";

/**
 * Zernio allows five seconds for a webhook response. The AI turn is explicitly
 * downstream of the durable inbox write and may take much longer, so it must
 * never hold the acknowledgement open.
 */
describe("ZernioService webhook acknowledgement", () => {
  it("returns after persisting even when the AI bridge never resolves", async () => {
    const prisma = {
      integration: {
        findFirst: jest.fn(async () => ({
          workspaceId: "ws1",
          platform: "whatsapp",
          provider: "zernio",
          pageId: "wa-account-1",
        })),
      },
      message: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: "msg-db-1" })),
      },
      contact: {
        upsert: jest.fn(async () => ({ id: "contact-1", name: "Ash", phone: "+962790286021" })),
        update: jest.fn(),
      },
      conversation: {
        findFirst: jest.fn(async () => ({
          id: "conv-db-1",
          externalId: "conv-zernio-1",
          aiEnabled: true,
          aiPausedAt: null,
        })),
        update: jest.fn(async () => ({})),
        create: jest.fn(),
      },
    };

    const aiNeverFinishes = new Promise<void>(() => {});
    const aiBridge = {
      isConfigured: () => true,
      notifyInbound: jest.fn(() => aiNeverFinishes),
    } as unknown as AiBridgeService;

    const svc = new ZernioService(
      prisma as never,
      { emitToWorkspace: jest.fn() } as never,
      {} as never,
      {} as never,
      { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn() } as never,
      aiBridge,
    );

    const handled = svc.handleEvent({
      event: "message.received",
      message: {
        id: "zernio-msg-1",
        conversationId: "conv-zernio-1",
        platform: "whatsapp",
        direction: "incoming",
        text: "مرحبا",
        sender: { id: "962790286021", name: "Ash" },
        attachments: [],
      },
      conversation: {
        id: "conv-zernio-1",
        participantId: "962790286021",
        participantName: "Ash",
      },
      account: {
        id: "wa-account-1",
        accountId: "wa-account-1",
        platform: "whatsapp",
      },
    });

    const result = await Promise.race([
      handled.then(() => "acknowledged"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked-by-ai"), 50)),
    ]);

    expect(result).toBe("acknowledged");
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(aiBridge.notifyInbound).toHaveBeenCalledTimes(1);
  });
});
