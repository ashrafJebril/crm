import { ZernioService, mediaKind } from "./zernio.service";
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

describe("the agent reads the customer's files", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function agentSetup(media: Array<{ kind: string; text: string | null; handled: boolean }>) {
    const prisma = makeFakePrisma({
      channel: [waChannel],
      conversation: [{ id: "conv-1", workspaceId: "ws1", escalated: false, aiPausedAt: null }],
      message: [
        { id: "m-voice", workspaceId: "ws1", conversationId: "conv-1", from: "them", body: "[audio]", attach: "md-a" },
        { id: "m-video", workspaceId: "ws1", conversationId: "conv-1", from: "them", body: "[video]", attach: "md-v" },
      ],
    });
    const realtime = { emitToWorkspace: jest.fn() };
    const mediaSvc = {
      get: jest.fn(async (_ws: string, id: string) => ({
        storageKind: "spaces",
        mimeType: id === "md-a" ? "audio/ogg" : "video/mp4",
      })),
      resolveExternalUrl: jest.fn(async (_ws: string, id: string) => `https://spaces.example/${id}?sig=1`),
    };
    const lAgent = { enabled: true, ask: jest.fn(async () => ({ answer: "شكراً، وصلنا", media })) };
    const svc = new ZernioService(
      prisma,
      realtime as never,
      mediaSvc as never,
      {} as never,
      {} as never,
      lAgent as never,
      {} as never,
    );
    const sendInDbConversation = jest.fn(async () => ({ messageId: "m-reply" }));
    (svc as unknown as { sendInDbConversation: unknown }).sendInDbConversation = sendInDbConversation;
    const reply = (files: Array<{ messageId: string; mediaId: string }>, ownText = "") =>
      (svc as unknown as { queueAgentReply: (...a: unknown[]) => void }).queueAgentReply(
        "ws1", "conv-1", "[audio]", null, { media: files, ownText },
      );
    return { prisma, lAgent, reply, sendInDbConversation, realtime };
  }

  it("sends the files instead of the placeholder and keeps the voice note's transcript", async () => {
    const { prisma, lAgent, reply, sendInDbConversation } = agentSetup([
      { kind: "audio", text: "بدي اشترك", handled: true },
    ]);
    reply([{ messageId: "m-voice", mediaId: "md-a" }]);
    await flush(); await flush();

    expect(lAgent.ask).toHaveBeenCalledWith("ws1", {
      externalId: "conv-1",
      message: "",
      attachments: [{ url: "https://spaces.example/md-a?sig=1", mimeType: "audio/ogg", kind: "audio" }],
    });
    expect(sendInDbConversation).toHaveBeenCalled();
    expect(prisma.db.message.find((m: { id: string }) => m.id === "m-voice").transcript).toBe("بدي اشترك");
    expect(prisma.db.conversation[0].escalated).toBe(false);
  });

  it("answers, then hands the thread to a person when a video was sent", async () => {
    const { prisma, reply, sendInDbConversation, realtime } = agentSetup([
      { kind: "video", text: null, handled: false },
    ]);
    reply([{ messageId: "m-video", mediaId: "md-v" }]);
    await flush(); await flush();

    expect(sendInDbConversation).toHaveBeenCalled();
    expect(prisma.db.conversation[0].escalated).toBe(true);
    expect(prisma.db.conversation[0].aiPausedAt).toBeInstanceOf(Date);
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "inbox.activity", { conversationId: "conv-1", escalated: true });
  });

  it("sends the text as before when there are no files", async () => {
    const { lAgent, reply } = agentSetup([]);
    reply([], "hello");
    await flush(); await flush();
    expect(lAgent.ask).toHaveBeenCalledWith("ws1", { externalId: "conv-1", message: "[audio]" });
  });

  it("reads a stored type as the kind l expects", () => {
    expect(["image/png", "audio/mp4", "video/webm", "application/pdf"].map(mediaKind)).toEqual([
      "image", "audio", "video", "file",
    ]);
  });
});
