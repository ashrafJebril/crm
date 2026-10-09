import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";

const WS = "ws-1";
const CONV = "conv-1";

/** A customer message arriving from Facebook via Zernio. */
const inbound = {
  type: "message.received",
  account: { accountId: "page-1", platform: "facebook" },
  conversation: { id: "z-conv-1", participantId: "psid-1", participantName: "Ada" },
  message: { id: "m-1", text: "Hello what do you offer", platform: "facebook" },
};

function build(
  conversation: Record<string, unknown>,
  ask: jest.Mock,
  opts: { bridgeConfigured?: boolean; workspace?: Record<string, unknown> | null } = {},
) {
  const prisma: any = {
    integration: {
      findFirst: jest.fn().mockResolvedValue({ workspaceId: WS, platform: "facebook", pageId: "page-1" }),
    },
    message: {
      findFirst: jest.fn().mockResolvedValue(null), // not a redelivery
      create: jest.fn().mockResolvedValue({ id: "m-db" }),
    },
    contact: {
      upsert: jest.fn().mockResolvedValue({ id: "contact-1", phone: null }),
      update: jest.fn(),
    },
    conversation: {
      findFirst: jest.fn().mockResolvedValue(conversation),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    workspace: { findUnique: jest.fn().mockResolvedValue(opts.workspace ?? null) },
  };
  const notifyInbound = jest.fn();
  const realtime: any = { emitToWorkspace: jest.fn() };
  const svc = new ZernioService(
    prisma as unknown as PrismaService,
    realtime as unknown as RealtimeService,
    {} as unknown as MediaService,
    {} as unknown as ZernioClient,
    { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
    { ask, enabled: true } as never,
    { isConfigured: () => opts.bridgeConfigured === true, notifyInbound } as never,
  );
  const send = jest
    .spyOn(svc as never as { sendInDbConversation: () => Promise<unknown> }, "sendInDbConversation")
    .mockResolvedValue({ ok: true });
  return { svc, prisma, realtime, send, notifyInbound };
}

/** The auto-reply is fire-and-forget, so let its microtasks drain. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

describe("ZernioService — l agent auto-reply on inbound social messages", () => {
  afterEach(() => jest.restoreAllMocks());

  it("answers and sends back out when the thread has AI mode on", async () => {
    const ask = jest.fn().mockResolvedValue({ answer: "We offer property management." });
    const { svc, send } = build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask);

    await svc.handleEvent(inbound as never);
    await settle();

    expect(ask).toHaveBeenCalledWith(WS, {
      externalId: CONV,
      message: "Hello what do you offer",
    });
    expect(send).toHaveBeenCalledWith(
      WS,
      CONV,
      "We offer property management.",
      undefined,
      undefined,
      "ai",
      undefined,
    );
  });

  it("stays silent on a thread that has not opted in", async () => {
    const ask = jest.fn();
    const { svc, send } = build({ id: CONV, aiEnabled: false, channel: "facebook" }, ask);

    await svc.handleEvent(inbound as never);
    await settle();

    // The whole point of opt-in: a live page does not start answering by itself.
    expect(ask).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("stays silent while a human has taken the thread over", async () => {
    const ask = jest.fn();
    const { svc, send } = build(
      { id: CONV, aiEnabled: true, aiPausedAt: new Date(), channel: "facebook" },
      ask,
    );

    await svc.handleEvent(inbound as never);
    await settle();

    expect(ask).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the kewy-ai bridge out of a thread the workspace's l agent answers", async () => {
    const ask = jest.fn().mockResolvedValue({ answer: "We offer property management." });
    const { svc, send, notifyInbound } = build(
      { id: CONV, aiEnabled: true, channel: "facebook" },
      ask,
      { bridgeConfigured: true, workspace: { lEndpointId: "ep-1", lEndpointSecret: "s3cret" } },
    );

    await svc.handleEvent(inbound as never);
    await settle();

    // Both platforms key off the same flag; one message must get one reply.
    expect(send).toHaveBeenCalledTimes(1);
    expect(notifyInbound).not.toHaveBeenCalled();
  });

  it("hands the message to the kewy-ai bridge when the workspace has no l endpoint", async () => {
    const ask = jest.fn().mockResolvedValue(null); // what ask() returns for an unlinked workspace
    const { svc, send, notifyInbound } = build(
      { id: CONV, aiEnabled: true, channel: "facebook" },
      ask,
      { bridgeConfigured: true, workspace: { lEndpointId: null, lEndpointSecret: null } },
    );

    await svc.handleEvent(inbound as never);
    await settle();

    expect(send).not.toHaveBeenCalled();
    expect(notifyInbound).toHaveBeenCalledTimes(1);
  });

  it("does not answer our own outbound echo", async () => {
    const ask = jest.fn();
    const { svc, send } = build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask);

    await svc.handleEvent({
      ...inbound,
      message: { ...inbound.message, direction: "outgoing" },
    } as never);
    await settle();

    // Otherwise the agent answers itself, forever.
    expect(ask).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("writes nothing when the agent gives no answer", async () => {
    const ask = jest.fn().mockResolvedValue(null);
    const { svc, prisma, send } = build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask);

    await svc.handleEvent(inbound as never);
    await settle();

    expect(send).not.toHaveBeenCalled();
    const aiWrites = prisma.message.create.mock.calls.filter(
      (c: [{ data: { from: string } }]) => c[0].data.from === "ai",
    );
    expect(aiWrites).toHaveLength(0);
  });

  it("does not store a reply the customer never received", async () => {
    const ask = jest.fn().mockResolvedValue({ answer: "hi" });
    const { svc, prisma, send } = build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask);
    send.mockRejectedValue(new Error("zernio down"));

    await svc.handleEvent(inbound as never);
    await settle();

    // Sending fails → nothing is written, so the thread does not read as
    // answered when the customer got nothing.
    const aiWrites = prisma.message.create.mock.calls.filter(
      (c: [{ data: { from: string } }]) => c[0].data.from === "ai",
    );
    expect(aiWrites).toHaveLength(0);
  });

  it("forwards the image url as an external attachment", async () => {
    const ask = jest
      .fn()
      .mockResolvedValue({ answer: "here's one", imageUrl: "https://cdn.example.com/pic.png" });
    const { svc, send } = build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask);

    await svc.handleEvent(inbound as never);
    await settle();

    expect(send).toHaveBeenCalledWith(
      WS,
      CONV,
      "here's one",
      undefined,
      undefined,
      "ai",
      { url: "https://cdn.example.com/pic.png", type: "image" },
    );
  });

  it("retries text-only when the channel rejects the image, so the customer still gets the answer", async () => {
    const ask = jest
      .fn()
      .mockResolvedValue({ answer: "here's one", imageUrl: "https://cdn.example.com/pic.png" });
    const { svc, send } = build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask);
    send
      .mockRejectedValueOnce(new Error("zernio: channel could not fetch attachment"))
      .mockResolvedValueOnce({ ok: true });

    await svc.handleEvent(inbound as never);
    await settle();

    // A bad image costs the image, never the reply: first call still carried
    // the attachment, but the retry drops it and keeps the text.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(
      1,
      WS,
      CONV,
      "here's one",
      undefined,
      undefined,
      "ai",
      { url: "https://cdn.example.com/pic.png", type: "image" },
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      WS,
      CONV,
      "here's one",
      undefined,
      undefined,
      "ai",
      undefined,
    );
  });
});
