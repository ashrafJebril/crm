import { ZernioService } from "./zernio.service";
import { WhatsAppService } from "./whatsapp.service";
import { makeFakePrisma } from "../channels/test-prisma";

/**
 * SP-19 Review Focus 1: number B isolation. Real ZernioService / WhatsAppService
 * over an in-memory Prisma, with the default ChannelResolver.
 */

const channel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "zernio",
  externalId: `acc-${id}`,
  displayName: `Number ${id}`,
  status: "active",
  isDefault: id === "A",
  integrationId: null,
  secretsEnc: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

function zernio(prisma: ReturnType<typeof makeFakePrisma>, client: Record<string, unknown> = {}) {
  const realtime = { emitToWorkspace: jest.fn() };
  const svc = new ZernioService(
    prisma,
    realtime as never,
    {} as never,
    client as never,
    { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) } as never,
    { enabled: false } as never,
    { isConfigured: () => false } as never,
  );
  return { svc, realtime };
}

function meta(prisma: ReturnType<typeof makeFakePrisma>) {
  const realtime = { emitToWorkspace: jest.fn() };
  const svc = new WhatsAppService(
    prisma,
    realtime as never,
    {} as never,
    { onInboundMessage: jest.fn(async () => {}) } as never,
    { isConfigured: () => false } as never,
  );
  return { svc, realtime };
}

const zernioEvent = (accountId: string, msgId: string) => ({
  event: "message.received",
  message: {
    id: msgId,
    platform: "whatsapp",
    direction: "incoming",
    text: `hi ${accountId}`,
    sender: { id: "962790000001", name: "Sara" },
  },
  conversation: { id: `zc-${accountId}`, participantId: "962790000001", participantName: "Sara" },
  account: { accountId, platform: "whatsapp" },
});

const metaEvent = (phoneNumberId: string, wamid: string) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "waba",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: phoneNumberId },
            contacts: [{ wa_id: "962790000001", profile: { name: "Sara" } }],
            messages: [{ from: "962790000001", id: wamid, timestamp: "1700000000", type: "text", text: { body: `hi ${phoneNumberId}` } }],
          },
        },
      ],
    },
  ],
});

describe("inbound on number B lands in B's conversations", () => {
  it("Zernio: account B creates a B conversation; the same contact on A gets a separate A conversation", async () => {
    const prisma = makeFakePrisma({ channel: [channel("A"), channel("B")] });
    const { svc, realtime } = zernio(prisma);

    await svc.handleEvent(zernioEvent("acc-B", "m1"));
    expect(prisma.db.conversation).toHaveLength(1);
    expect(prisma.db.conversation[0]).toMatchObject({ channelId: "B", channel: "whatsapp", externalId: "zc-acc-B" });
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "inbox.activity", expect.objectContaining({ channelId: "B" }));

    await svc.handleEvent(zernioEvent("acc-A", "m2"));
    expect(prisma.db.contact).toHaveLength(1); // the contact is shared
    expect(prisma.db.conversation).toHaveLength(2);
    const [b, a] = prisma.db.conversation;
    expect(a.channelId).toBe("A");
    expect(prisma.db.message.filter((m: { conversationId: string }) => m.conversationId === b.id)).toHaveLength(1);
    expect(prisma.db.message.filter((m: { conversationId: string }) => m.conversationId === a.id)).toHaveLength(1);

    // B again reuses B's thread and never touches A's
    await svc.handleEvent(zernioEvent("acc-B", "m3"));
    expect(prisma.db.conversation).toHaveLength(2);
    expect(b.unread).toBe(2);
    expect(a.unread).toBe(1);
  });

  it("Zernio: status and reaction events resolve the workspace through the channel", async () => {
    const prisma = makeFakePrisma({
      channel: [channel("B")],
      message: [{ id: "msg", workspaceId: "ws1", conversationId: "cv", metaMessageId: "zm-1", deliveryStatus: null }],
    });
    const { svc } = zernio(prisma);
    await svc.handleEvent({ event: "message.delivered", message: { id: "zm-1" }, account: { accountId: "acc-B" } });
    expect(prisma.db.message[0].deliveryStatus).toBe("delivered");
    await svc.handleEvent({ event: "reaction.received", reaction: { messageId: "zm-1", emoji: "👍" }, account: { accountId: "acc-B" } });
    expect(prisma.db.message[0].reaction).toBe("👍");
  });

  it("Meta: phone_number_id B creates a B conversation; the same contact on A gets an A conversation", async () => {
    const prisma = makeFakePrisma({
      channel: [channel("A", { provider: "meta", externalId: "pn-A" }), channel("B", { provider: "meta", externalId: "pn-B" })],
    });
    const { svc } = meta(prisma);
    await svc.handleWebhook(metaEvent("pn-B", "wamid.1"));
    expect(prisma.db.conversation).toHaveLength(1);
    expect(prisma.db.conversation[0].channelId).toBe("B");
    await svc.handleWebhook(metaEvent("pn-A", "wamid.2"));
    expect(prisma.db.conversation).toHaveLength(2);
    expect(prisma.db.conversation[1].channelId).toBe("A");
    expect(prisma.db.contact).toHaveLength(1);
  });

  it("existing single-number workspace: a legacy null-channel thread keeps receiving (no drop, no split)", async () => {
    const prisma = makeFakePrisma({
      integration: [{ id: "int", workspaceId: "ws1", platform: "whatsapp", provider: "meta", pageId: "pn-1", pageName: "", accessToken: "t", createdAt: new Date() }],
      contact: [{ id: "c1", workspaceId: "ws1", externalSource: "whatsapp", externalId: "962790000001", name: "Sara", phone: "+962790000001" }],
      conversation: [{ id: "legacy", workspaceId: "ws1", contactId: "c1", channel: "whatsapp", channelId: null, unread: 0, updatedAt: new Date() }],
    });
    const { svc } = meta(prisma);
    await svc.handleWebhook(metaEvent("pn-1", "wamid.9"));
    expect(prisma.db.channel).toHaveLength(1); // mirrored on the fly
    expect(prisma.db.conversation).toHaveLength(1);
    expect(prisma.db.conversation[0]).toMatchObject({ id: "legacy", channelId: "chi_int", unread: 1 });
  });
});

describe("reply from B's conversation sends through B's account", () => {
  it("Zernio: the client receives accountId = B", async () => {
    const prisma = makeFakePrisma({
      channel: [channel("A"), channel("B")],
      contact: [{ id: "c1", workspaceId: "ws1", externalId: "962790000001" }],
      conversation: [{ id: "cv-b", workspaceId: "ws1", contactId: "c1", channel: "whatsapp", channelId: "B", externalId: "zc-b" }],
    });
    const client = { sendMessage: jest.fn(async () => ({ id: "out-1" })), sendTemplateMessage: jest.fn(async () => ({ id: "out-2" })) };
    const { svc } = zernio(prisma, client);
    await svc.sendInDbConversation("ws1", "cv-b", "hello");
    expect(client.sendMessage).toHaveBeenCalledWith("zc-b", "acc-B", "hello", undefined);
    await svc.sendTemplateInDbConversation("ws1", "cv-b", "promo", "en", []);
    expect(client.sendTemplateMessage).toHaveBeenCalledWith("zc-b", "acc-B", { name: "promo", language: "en" });
  });

  it("Zernio: an unresolved thread is matched among B's account conversations only", async () => {
    const prisma = makeFakePrisma({
      workspace: [{ id: "ws1", zernioProfileId: "prof" }],
      channel: [channel("A"), channel("B")],
      contact: [{ id: "c1", workspaceId: "ws1", externalId: "962790000001" }],
      conversation: [{ id: "cv-b", workspaceId: "ws1", contactId: "c1", channel: "whatsapp", channelId: "B", externalId: null }],
    });
    const client = {
      listConversations: jest.fn(async () => [
        { id: "zc-on-A", accountId: "acc-A", platform: "whatsapp", participantId: "962790000001" },
        { id: "zc-on-B", accountId: "acc-B", platform: "whatsapp", participantId: "962790000001" },
      ]),
      sendMessage: jest.fn(async () => ({ id: "out" })),
    };
    const { svc } = zernio(prisma, client);
    await svc.sendInDbConversation("ws1", "cv-b", "hello");
    expect(client.sendMessage).toHaveBeenCalledWith("zc-on-B", "acc-B", "hello", undefined);
    expect(prisma.db.conversation[0].externalId).toBe("zc-on-B");
  });

  it("Meta: the Graph URL uses phone id B and B's token", async () => {
    const prisma = makeFakePrisma({
      integration: [{ id: "int-a", workspaceId: "ws1", platform: "whatsapp", provider: "meta", pageId: "pn-A", accessToken: "TOKEN-A", createdAt: new Date() }],
      channel: [
        channel("A", { provider: "meta", externalId: "pn-A", integrationId: "int-a" }),
        channel("B", { provider: "meta", externalId: "pn-B", secretsEnc: JSON.stringify({ accessToken: "TOKEN-B" }) }),
      ],
      contact: [{ id: "c1", workspaceId: "ws1", externalId: "962790000001", phone: "+962790000001" }],
      conversation: [{ id: "cv-b", workspaceId: "ws1", contactId: "c1", channel: "whatsapp", channelId: "B" }],
    });
    const { svc } = meta(prisma);
    const fetchJson = jest
      .spyOn(svc as unknown as { fetchJson: (u: string, i: RequestInit) => Promise<unknown> }, "fetchJson")
      .mockResolvedValue({ messages: [{ id: "wamid.out" }] });

    await svc.sendInConversation("ws1", "cv-b", "hello");
    let [url, init] = fetchJson.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/pn-B/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN-B");

    await svc.sendTemplateInConversation("ws1", "cv-b", "promo", "en", []);
    [url, init] = fetchJson.mock.calls[1];
    expect(url).toBe("https://graph.facebook.com/v21.0/pn-B/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN-B");

    // and A's (legacy) thread still uses the Integration's token
    prisma.db.conversation.push({ id: "cv-a", workspaceId: "ws1", contactId: "c1", channel: "whatsapp", channelId: null });
    await svc.sendInConversation("ws1", "cv-a", "hi");
    [url, init] = fetchJson.mock.calls[2];
    expect(url).toBe("https://graph.facebook.com/v21.0/pn-A/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN-A");
  });

  it("Meta and Zernio refuse a disconnected number instead of rerouting", async () => {
    const prisma = makeFakePrisma({
      channel: [channel("A", { provider: "meta", externalId: "pn-A" }), channel("B", { provider: "meta", externalId: "pn-B", status: "disconnected", isDefault: false })],
      contact: [{ id: "c1", workspaceId: "ws1", externalId: "962790000001" }],
      conversation: [{ id: "cv-b", workspaceId: "ws1", contactId: "c1", channel: "whatsapp", channelId: "B", externalId: "zc" }],
    });
    const { svc } = meta(prisma);
    const fetchJson = jest.spyOn(svc as unknown as { fetchJson: () => Promise<unknown> }, "fetchJson");
    await expect(svc.sendInConversation("ws1", "cv-b", "x")).rejects.toMatchObject({ response: { message: "channels.disconnected" } });
    expect(fetchJson).not.toHaveBeenCalled();

    const client = { sendMessage: jest.fn() };
    const z = zernio(prisma, client);
    await expect(z.svc.sendInDbConversation("ws1", "cv-b", "x")).rejects.toMatchObject({ response: { message: "channels.disconnected" } });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
