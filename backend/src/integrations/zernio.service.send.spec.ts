import { AiBridgeService } from "./ai-bridge.service";
import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";

/**
 * Caption handling on media sends.
 *
 * Instagram and Messenger DMs carry one body shape per message — text OR an
 * attachment — so a caption is impossible there: handing Zernio both in a
 * single call delivered the image and silently dropped the text (reported
 * 2026-08-20). Those channels must split into two sends. WhatsApp supports
 * media captions, so it must keep the single call.
 */
describe("ZernioService.sendInDbConversation — text + attachment", () => {
  const workspaceId = "ws1";

  const build = (channel: string) => {
    const prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: "conv-db",
          channel,
          externalId: "z-conv",
          contactId: "c1",
          contact: { externalId: "p1" },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      integration: {
        findFirst: jest.fn().mockResolvedValue({ pageId: "acc1", platform: channel }),
      },
      message: { create: jest.fn().mockResolvedValue({}) },
    };
    const client = {
      sendMessage: jest.fn().mockResolvedValue({ id: "m1" }),
    };
    const media = {
      get: jest.fn().mockResolvedValue({ mimeType: "image/png", storageKind: "spaces" }),
      resolveExternalUrl: jest.fn().mockResolvedValue("https://spaces.example/img.png"),
    };
    const svc = new ZernioService(
      prisma as unknown as PrismaService,
      { emitToWorkspace: jest.fn() } as unknown as RealtimeService,
      media as unknown as MediaService,
      client as unknown as ZernioClient,
      { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
        { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
);
    return { svc, client, prisma };
  };

  it("splits image and caption into two sends on Instagram", async () => {
    const { svc, client } = build("instagram");
    await svc.sendInDbConversation(workspaceId, "conv-db", "هاد الشعار ؟", "media-1");

    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    // First: the image with no text.
    expect(client.sendMessage.mock.calls[0]).toEqual([
      "z-conv",
      "acc1",
      "",
      { url: "https://spaces.example/img.png", type: "image" },
    ]);
    // Second: the text as its own message, no attachment.
    expect(client.sendMessage.mock.calls[1]).toEqual(["z-conv", "acc1", "هاد الشعار ؟"]);
  });

  it("keeps one captioned send on WhatsApp", async () => {
    const { svc, client } = build("whatsapp");
    await svc.sendInDbConversation(workspaceId, "conv-db", "هاد الشعار ؟", "media-1");

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls[0]).toEqual([
      "z-conv",
      "acc1",
      "هاد الشعار ؟",
      { url: "https://spaces.example/img.png", type: "image" },
    ]);
  });

  it("sends once for an image with no caption", async () => {
    const { svc, client } = build("instagram");
    await svc.sendInDbConversation(workspaceId, "conv-db", "", "media-1");
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends once for text with no image", async () => {
    const { svc, client } = build("instagram");
    await svc.sendInDbConversation(workspaceId, "conv-db", "just text");
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls[0][3]).toBeUndefined();
  });

  it("stores one DB message carrying both the caption and the media id", async () => {
    const { svc, prisma } = build("instagram");
    await svc.sendInDbConversation(workspaceId, "conv-db", "هاد الشعار ؟", "media-1");
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    const data = prisma.message.create.mock.calls[0][0].data;
    expect(data.body).toBe("هاد الشعار ؟");
    expect(data.attach).toBe("media-1");
  });
});
