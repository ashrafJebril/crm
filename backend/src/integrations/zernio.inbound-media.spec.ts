import { ZernioService } from "./zernio.service";
import { makeFakePrisma } from "../channels/test-prisma";

/**
 * Customer media on Zernio: a voice note used to be refused (only images and
 * videos were accepted) and only the first of several files was kept.
 */

const waChannel = {
  id: "ch-wa",
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "zernio",
  externalId: "acc-wa",
  displayName: "Kewy",
  status: "active",
  isDefault: true,
  integrationId: null,
  secretsEnc: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

function build(prisma: ReturnType<typeof makeFakePrisma>) {
  let n = 0;
  const media = {
    ingestInboundAttachment: jest.fn(async (i: { attachmentType?: string }) => {
      if (i.attachmentType === "broken") throw new Error("media.type_mismatch");
      return { id: `media-${++n}` };
    }),
  };
  const client = { downloadMedia: jest.fn(async () => ({ buffer: Buffer.from("OggS"), mimeType: "audio/ogg" })) };
  const svc = new ZernioService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    media as never,
    client as never,
    { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) } as never,
    { enabled: false } as never,
    { isConfigured: () => false } as never,
  );
  return { svc, media, client };
}

type Att = { type?: string; url?: string; payload?: { id?: string; mimeType?: string } };
const event = (attachments: Att[]) => ({
  event: "message.received",
  conversation: { id: "zc-1", participantId: "962790000000", participantName: "Abdullah" },
  account: { accountId: "acc-wa", platform: "whatsapp" },
  message: { id: "wamid-1", platform: "whatsapp", text: null, sender: { id: "962790000000" }, attachments },
});

const rows = (prisma: ReturnType<typeof makeFakePrisma>) =>
  prisma.db.message.map((m: { body: string; attach: string | null; metaMessageId: string | null }) => ({
    body: m.body,
    attach: m.attach,
    metaMessageId: m.metaMessageId,
  }));

describe("Zernio inbound media", () => {
  it("stores a voice note and hands its declared types to the media service", async () => {
    const prisma = makeFakePrisma({ channel: [waChannel] });
    const { svc, media } = build(prisma);
    await svc.handleEvent(
      event([{ type: "audio", url: "https://zernio/x", payload: { id: "a1", mimeType: "audio/ogg; codecs=opus" } }]),
    );
    expect(rows(prisma)).toEqual([{ body: "[audio]", attach: "media-1", metaMessageId: "wamid-1" }]);
    expect(media.ingestInboundAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentType: "audio", declaredMimes: ["audio/ogg; codecs=opus", "audio/ogg"], fileName: "whatsapp-a1" }),
    );
  });

  it("keeps every file of a message, each in its own bubble", async () => {
    const prisma = makeFakePrisma({ channel: [waChannel] });
    const { svc } = build(prisma);
    await svc.handleEvent(
      event([
        { type: "image", url: "https://zernio/1" },
        { type: "document", url: "https://zernio/2" },
      ]),
    );
    expect(rows(prisma)).toEqual([
      { body: "[image]", attach: "media-1", metaMessageId: "wamid-1" },
      { body: "[document]", attach: "media-2", metaMessageId: "wamid-1#2" },
    ]);
  });

  it("keeps the message when a file cannot be stored", async () => {
    const prisma = makeFakePrisma({ channel: [waChannel] });
    const { svc } = build(prisma);
    await svc.handleEvent(event([{ type: "broken", url: "https://zernio/1" }]));
    expect(rows(prisma)).toEqual([{ body: "[broken]", attach: null, metaMessageId: "wamid-1" }]);
  });
});
