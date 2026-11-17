import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";
import { makeFakePrisma } from "../channels/test-prisma";
import { AgentReplyGate, invalidateAgentGate } from "../agent/agent-reply-gate";
import { WhatsAppService } from "./whatsapp.service";
import { ConversationsService } from "../conversations/conversations.service";
import { ChannelResolver } from "../channels/channel-resolver.service";
import { ChannelTransportRegistry } from "../channels/channel-transport";
import { ZernioController } from "./zernio.controller";

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
  opts: { bridgeConfigured?: boolean; locked?: boolean; workspace?: Record<string, unknown> | null } = {},
) {
  const prisma: any = {
    integration: {
      findFirst: jest.fn().mockResolvedValue({ workspaceId: WS, platform: "facebook", pageId: "page-1" }),
    },
    // SP-19: the account's channel decides workspace and thread.
    channel: {
      findMany: jest.fn().mockResolvedValue([
        { id: "ch1", workspaceId: WS, kind: "facebook", provider: "zernio", externalId: "page-1", status: "active", integrationId: "i1" },
      ]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
    undefined,
    { isLocked: jest.fn(async () => opts.locked === true) } as never,
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

  it("does not ask or send for a payment-locked workspace, but still stores the message", async () => {
    const ask = jest.fn().mockResolvedValue({ answer: "hi" });
    const { svc, send, prisma } = build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask, {
      locked: true,
    });

    await svc.handleEvent(inbound as never);
    await settle();

    expect(prisma.message.create).toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
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

  it("stays silent on an escalated thread (WhatsApp/Zernio, like Telegram and web chat)", async () => {
    const ask = jest.fn().mockResolvedValue({ answer: "hi" });
    const { svc, send, prisma } = build({ id: CONV, aiEnabled: true, escalated: true, channel: "facebook" }, ask);

    await svc.handleEvent(inbound as never);
    await settle();

    expect(prisma.message.create).toHaveBeenCalled();
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

describe("agent reply drops an unapproved CRM photo but keeps the text", () => {
  const ENV_KEYS = ["PUBLIC_BASE_URL", "APP_BASE_URL", "DO_SPACES_BUCKET", "DO_SPACES_ENDPOINT", "DO_SPACES_CDN_ENDPOINT"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.PUBLIC_BASE_URL = "https://crm.example.test";
    delete process.env.APP_BASE_URL;
    process.env.DO_SPACES_BUCKET = "aram";
    process.env.DO_SPACES_ENDPOINT = "https://fra1.digitaloceanspaces.com";
    delete process.env.DO_SPACES_CDN_ENDPOINT;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
  });

  const TOKEN = "tok_SECRET_123";
  const photo = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    workspaceId: WS,
    mimeType: "image/jpeg",
    sizeBytes: 1000,
    approvedForAgent: true,
    storedPath: `${WS}/${id}.jpg`,
    ...over,
  });

  async function run(imageUrl: string, rows: Record<string, unknown>[]) {
    const ask = jest.fn().mockResolvedValue({ answer: "here's the menu", imageUrl });
    const built = build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask);
    built.prisma.media = makeFakePrisma({ media: rows }).media;
    const warn = jest.spyOn((built.svc as any).log, "warn").mockImplementation(() => undefined);
    await built.svc.handleEvent(inbound as never);
    await settle();
    return { ...built, warn };
  }

  const textOnly = (send: jest.SpyInstance) => {
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(WS, CONV, "here's the menu", undefined, undefined, "ai", undefined);
  };

  it("our public-token URL for an approved photo is sent with the image", async () => {
    const url = `https://crm.example.test/api/media/p1/public?token=${TOKEN}`;
    const { send } = await run(url, [photo("p1")]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(WS, CONV, "here's the menu", undefined, undefined, "ai", { url, type: "image" });
  });

  it("the same photo hidden: one text-only send and a log line with the id, never the token", async () => {
    const url = `https://crm.example.test/api/media/p1/public?token=${TOKEN}`;
    const { send, warn } = await run(url, [photo("p1", { approvedForAgent: false })]);
    textOnly(send);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes("agent image dropped: not approved"));
    expect(line).toContain("p1");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("a Spaces URL whose path is the storedPath of an unapproved row -> text only", async () => {
    const url = `https://aram.fra1.digitaloceanspaces.com/${WS}/p2.jpg?X-Amz-Signature=abc`;
    const { send } = await run(url, [photo("p2", { approvedForAgent: false })]);
    textOnly(send);
  });

  it("another workspace's approved photo URL -> text only", async () => {
    const url = `https://crm.example.test/api/media/theirs/public?token=${TOKEN}`;
    const { send } = await run(url, [photo("theirs", { workspaceId: "ws-other" })]);
    textOnly(send);
  });

  it("an external URL is sent as today", async () => {
    const url = "https://example.com/x.jpg";
    const { send } = await run(url, []);
    expect(send).toHaveBeenCalledWith(WS, CONV, "here's the menu", undefined, undefined, "ai", { url, type: "image" });
  });

  it("a failing approval lookup drops the image, never the answer", async () => {
    const ask = jest.fn().mockResolvedValue({
      answer: "here's the menu",
      imageUrl: `https://crm.example.test/api/media/p1/public?token=${TOKEN}`,
    });
    const built = build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask);
    built.prisma.media = { findFirst: jest.fn().mockRejectedValue(new Error("db down")) };
    jest.spyOn((built.svc as any).log, "warn").mockImplementation(() => undefined);
    await built.svc.handleEvent(inbound as never);
    await settle();
    textOnly(built.send);
  });
});

// ─── SP-20: the reply gate on every automatic reply path ─────────────────

/** A gate stub: `reply` decides, every call is recorded. */
const stubGate = (reply: boolean) => ({ allows: jest.fn(async () => reply), decide: jest.fn() });
const withGate = <T extends { svc: unknown }>(built: T, gate: unknown): T => {
  (built.svc as { replyGate?: unknown }).replyGate = gate;
  return built;
};

const sp20Channel = (over: Record<string, unknown> = {}) => ({
  id: "Z",
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "zernio",
  externalId: "acc-Z",
  displayName: "Z",
  status: "active",
  isDefault: true,
  integrationId: null,
  secretsEnc: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});
const zEvent = (msgId: string) => ({
  event: "message.received",
  message: { id: msgId, platform: "whatsapp", direction: "incoming", text: "hello", sender: { id: "962790000001", name: "Sara" } },
  conversation: { id: "zc-1", participantId: "962790000001", participantName: "Sara" },
  account: { accountId: "acc-Z", platform: "whatsapp" },
});
const mEvent = (wamid: string) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "waba",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "pn-M" },
            contacts: [{ wa_id: "962790000001", profile: { name: "Sara" } }],
            messages: [{ from: "962790000001", id: wamid, timestamp: "1700000000", type: "text", text: { body: "hello" } }],
          },
        },
      ],
    },
  ],
});

function metaWithGate(prisma: ReturnType<typeof makeFakePrisma>, gate: unknown) {
  const notifyInbound = jest.fn(async () => undefined);
  const svc = new WhatsAppService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    { onInboundMessage: jest.fn(async () => {}) } as never,
    { isConfigured: () => true, notifyInbound } as never,
  );
  (svc as unknown as { replyGate?: unknown }).replyGate = gate;
  return { svc, notifyInbound };
}

describe("SP-20 reply gate wiring", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    invalidateAgentGate();
  });

  it("every auto-reply path consults the gate", async () => {
    // (1) the l auto-reply in zernio.service.ts
    {
      const ask = jest.fn().mockResolvedValue({ answer: "hi" });
      const no = stubGate(false);
      const { svc, send } = withGate(build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask), no);
      await svc.handleEvent(inbound as never);
      await settle();
      expect(no.allows).toHaveBeenCalledWith(WS, { conversationId: CONV, contactId: "contact-1" }, "l_auto_reply");
      expect(ask).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();

      const yes = stubGate(true);
      const ok = withGate(build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask), yes);
      await ok.svc.handleEvent(inbound as never);
      await settle();
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ok.send).toHaveBeenCalledTimes(1);
    }
    // (2) the kewy-ai bridge in zernio.service.ts (no l endpoint)
    {
      const ask = jest.fn().mockResolvedValue(null);
      const no = stubGate(false);
      const { svc, notifyInbound } = withGate(
        build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask, { bridgeConfigured: true, workspace: { lEndpointId: null, lEndpointSecret: null } }),
        no,
      );
      await svc.handleEvent(inbound as never);
      await settle();
      expect(no.allows).toHaveBeenCalledWith(WS, { conversationId: CONV, contactId: "contact-1" }, "zernio_bridge");
      expect(notifyInbound).not.toHaveBeenCalled();

      const yes = stubGate(true);
      const ok = withGate(
        build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask, { bridgeConfigured: true, workspace: { lEndpointId: null, lEndpointSecret: null } }),
        yes,
      );
      await ok.svc.handleEvent(inbound as never);
      await settle();
      expect(ok.notifyInbound).toHaveBeenCalledTimes(1);
    }
    // (3) the kewy-ai bridge in whatsapp.service.ts (Meta)
    {
      const prisma = makeFakePrisma({ channel: [sp20Channel({ id: "M", provider: "meta", externalId: "pn-M" })] });
      const no = stubGate(false);
      const { svc, notifyInbound } = metaWithGate(prisma, no);
      await svc.handleWebhook(mEvent("wamid.1") as never);
      // A thread that has not opted in never reaches the gate.
      expect(no.allows).not.toHaveBeenCalled();
      prisma.db.conversation[0].aiEnabled = true;
      await svc.handleWebhook(mEvent("wamid.2") as never);
      expect(no.allows).toHaveBeenCalledWith(
        "ws1",
        { conversationId: prisma.db.conversation[0].id, contactId: prisma.db.contact[0].id },
        "meta_bridge",
      );
      expect(notifyInbound).not.toHaveBeenCalled();

      const yes = stubGate(true);
      (svc as unknown as { replyGate?: unknown }).replyGate = yes;
      await svc.handleWebhook(mEvent("wamid.3") as never);
      expect(notifyInbound).toHaveBeenCalledTimes(1);
    }
  });

  it("inbound is stored when the gate says no", async () => {
    const ask = jest.fn();
    const no = stubGate(false);
    const { svc, prisma, realtime, notifyInbound } = withGate(
      build({ id: CONV, aiEnabled: true, channel: "facebook" }, ask, { bridgeConfigured: true, workspace: { lEndpointId: null, lEndpointSecret: null } }),
      no,
    );
    await svc.handleEvent(inbound as never);
    await settle();
    expect(prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ from: "them" }) }));
    expect(realtime.emitToWorkspace).toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(notifyInbound).not.toHaveBeenCalled();

    // Meta: the message rows exist with the gate saying no.
    const mp = makeFakePrisma({ channel: [sp20Channel({ id: "M", provider: "meta", externalId: "pn-M" })] });
    const meta = metaWithGate(mp, no);
    await meta.svc.handleWebhook(mEvent("wamid.9") as never);
    mp.db.conversation[0].aiEnabled = true;
    await meta.svc.handleWebhook(mEvent("wamid.10") as never);
    expect(mp.db.message.map((m: { from: string }) => m.from)).toEqual(["them", "them"]);
    expect(meta.notifyInbound).not.toHaveBeenCalled();
  });

  it("gate error sends no reply", async () => {
    // The real gate over a Prisma whose settings read fails: fail closed.
    const prisma = makeFakePrisma({
      workspace: [{ id: "ws1", name: "S", slug: "s", timezone: "Asia/Riyadh", lEndpointId: null, lEndpointSecret: null }],
      channel: [sp20Channel()],
    });
    prisma.agentSettings.findUnique.mockImplementation(() => Promise.reject(new Error("db down")));
    const gate = new AgentReplyGate(prisma as never);
    jest.spyOn((gate as unknown as { log: { warn: () => void } }).log, "warn").mockImplementation(() => undefined);
    const ask = jest.fn().mockResolvedValue({ answer: "hi" });
    const notifyInbound = jest.fn();
    const svc = new ZernioService(
      prisma,
      { emitToWorkspace: jest.fn() } as never,
      {} as never,
      { sendMessage: jest.fn(async () => ({ id: "out" })) } as never,
      { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) } as never,
      { ask, enabled: true } as never,
      { isConfigured: () => true, notifyInbound } as never,
    );
    (svc as unknown as { replyGate?: unknown }).replyGate = gate;
    await svc.handleEvent(zEvent("m1") as never);
    prisma.db.conversation[0].aiEnabled = true;
    await svc.handleEvent(zEvent("m2") as never);
    await settle();
    expect(prisma.db.message.filter((m: { from: string }) => m.from === "them")).toHaveLength(2);
    expect(ask).not.toHaveBeenCalled();
    expect(notifyInbound).not.toHaveBeenCalled();
    expect(prisma.db.message.filter((m: { from: string }) => m.from === "ai")).toHaveLength(0);
  });

  it("excluded tag blocks auto-reply but not human send", async () => {
    const prisma = makeFakePrisma({
      workspace: [{ id: "ws1", name: "S", slug: "s", timezone: "Asia/Riyadh", lEndpointId: null, lEndpointSecret: null }],
      channel: [sp20Channel()],
      tag: [{ id: "tag-vip", workspaceId: "ws1", name: "VIP", color: "red" }],
      agentSettings: [{ id: "as1", workspaceId: "ws1", excludedTagIds: ["tag-vip"], hoursMode: "always", tone: [], version: 1, stoppedAt: null }],
      template: [],
      message: [],
    });
    const gate = new AgentReplyGate(prisma as never);
    const decide = jest.spyOn(gate, "decide");
    const allows = jest.spyOn(gate, "allows");
    const ask = jest.fn().mockResolvedValue({ answer: "auto" });
    const notifyInbound = jest.fn();
    const client = { sendMessage: jest.fn(async () => ({ id: "out-1" })) };
    const svc = new ZernioService(
      prisma,
      { emitToWorkspace: jest.fn() } as never,
      {} as never,
      client as never,
      { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) } as never,
      { ask, enabled: true } as never,
      { isConfigured: () => true, notifyInbound } as never,
    );
    (svc as unknown as { replyGate?: unknown }).replyGate = gate;

    // The first message creates the contact and thread; the owner tags the
    // customer VIP and the thread is in AI mode.
    await svc.handleEvent(zEvent("m1") as never);
    prisma.db.contact[0].tags = JSON.stringify(["VIP"]);
    prisma.db.conversation[0].aiEnabled = true;
    await svc.handleEvent(zEvent("m2") as never);
    await settle();

    // Stored, but neither the l agent nor the kewy-ai bridge is asked.
    expect(prisma.db.message.filter((m: { from: string }) => m.from === "them")).toHaveLength(2);
    expect(allows).toHaveBeenCalled();
    expect(await gate.decide("ws1", { conversationId: prisma.db.conversation[0].id, contactId: prisma.db.contact[0].id })).toEqual({
      reply: false,
      reason: "excluded",
    });
    expect(ask).not.toHaveBeenCalled();
    expect(notifyInbound).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();

    // A human send to the same conversation goes out exactly once and never asks the gate.
    decide.mockClear();
    allows.mockClear();
    const sendText = jest.fn(async () => ({ providerMessageId: "zm-human" }));
    const transports = new ChannelTransportRegistry();
    transports.register({ provider: "zernio", sendText } as never);
    const convs = new ConversationsService(
      prisma,
      { emitToWorkspace: jest.fn() } as never,
      { queueReply: jest.fn() } as never,
      undefined,
      { conversationScope: jest.fn(async () => ({})) } as never,
      new ChannelResolver(prisma),
      transports,
    );
    await convs.sendViaChannel("ws1", prisma.db.conversation[0].id, "A person writes back", { userId: "u1" });
    expect(sendText).toHaveBeenCalledTimes(1);
    // The inbox's Zernio route (the human path in use for Zernio threads) too.
    const controller = new ZernioController(
      svc,
      { humanReplied: jest.fn(async () => {}) } as never,
      { assertConversationVisible: jest.fn(async () => {}) } as never,
    );
    await controller.sendInDbConversation("ws1", prisma.db.conversation[0].id, { message: "Staff reply" } as never, { userId: "u1" });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();
    expect(allows).not.toHaveBeenCalled();
    expect(prisma.db.message.filter((m: { from: string }) => m.from === "human")).toHaveLength(2);
  });
});
