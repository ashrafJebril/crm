import { ZernioService } from "../integrations/zernio.service";
import { WhatsAppService } from "../integrations/whatsapp.service";
import { makeFakePrisma } from "./test-prisma";

/**
 * SP-19 fix round 1: C1 (reconnect after a legacy disconnect), C2 (the
 * legacy Integration changes identity) and I1 (a number moved between
 * workspaces). Real services over the faithful in-memory Prisma double
 * (FK SetNull on Integration delete, transactional rollback).
 */

const WA = "962790000001";

const integ = (over: Record<string, unknown> = {}) => ({
  id: "I1",
  workspaceId: "ws1",
  platform: "whatsapp",
  provider: "meta",
  pageId: "pn-1",
  pageName: "+962 79",
  accessToken: "TOKEN-1",
  raw: JSON.stringify({ wabaId: "waba", verifyToken: "v" }),
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});
const chan = (over: Record<string, unknown> = {}) => ({
  id: "chi_I1",
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "meta",
  externalId: "pn-1",
  displayName: "+962 79",
  status: "active",
  isDefault: true,
  integrationId: "I1",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});
const contact = { id: "c1", workspaceId: "ws1", externalSource: "whatsapp", externalId: WA, phone: `+${WA}`, name: "Sara" };
const conv = (over: Record<string, unknown> = {}) => ({
  id: "cv",
  workspaceId: "ws1",
  contactId: "c1",
  channel: "whatsapp",
  channelId: "chi_I1",
  externalId: null,
  unread: 0,
  updatedAt: new Date("2026-01-01"),
  ...over,
});

function meta(prisma: ReturnType<typeof makeFakePrisma>) {
  const svc = new WhatsAppService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    { onInboundMessage: jest.fn(async () => {}) } as never,
    { isConfigured: () => false } as never,
  );
  const any = svc as unknown as Record<string, unknown>;
  jest.spyOn(any as never, "unsubscribeAppFromWaba" as never).mockResolvedValue(undefined as never);
  jest.spyOn(any as never, "subscribeAppToWaba" as never).mockResolvedValue({ ok: true } as never);
  jest
    .spyOn(any as never, "graphGet" as never)
    .mockImplementation((async (path: string) => ({ id: path.split("?")[0].slice(1), display_phone_number: "+962 79" })) as never);
  const fetchJson = jest
    .spyOn(any as never, "fetchJson" as never)
    .mockResolvedValue({ messages: [{ id: "wamid.out" }] } as never) as unknown as jest.Mock;
  return { svc, fetchJson };
}

function zernio(prisma: ReturnType<typeof makeFakePrisma>, client: Record<string, unknown>) {
  return new ZernioService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    { isConfigured: () => true, ...client } as never,
    { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) } as never,
    { enabled: false } as never,
    { isConfigured: () => false } as never,
  );
}

const zEvent = (accountId: string, zconv: string, id: string) => ({
  event: "message.received",
  message: { id, platform: "whatsapp", direction: "incoming", text: "hi", sender: { id: WA, name: "Sara" } },
  conversation: { id: zconv, participantId: WA, participantName: "Sara" },
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
            contacts: [{ wa_id: WA, profile: { name: "Sara" } }],
            messages: [{ from: WA, id: wamid, timestamp: "1700000000", type: "text", text: { body: "hi" } }],
          },
        },
      ],
    },
  ],
});

describe("legacy disconnect then reconnect same number restores sending", () => {
  it("Meta: disconnect, connect the same phone number id again, reply works", async () => {
    const prisma = makeFakePrisma({ integration: [integ()], channel: [chan()], contact: [contact], conversation: [conv()] });
    const { svc, fetchJson } = meta(prisma);

    await svc.disconnect("ws1");
    expect(prisma.db.channel[0]).toMatchObject({ status: "disconnected", integrationId: null });
    await expect(svc.sendInConversation("ws1", "cv", "x")).rejects.toMatchObject({ response: { message: "channels.disconnected" } });

    await svc.connect("ws1", { phoneNumberId: "pn-1", wabaId: "waba", accessToken: "TOKEN-2", verifyToken: "v2" } as never);
    expect(prisma.db.channel).toHaveLength(1); // relinked, not duplicated
    expect(prisma.db.channel[0]).toMatchObject({ status: "active", statusReason: null, disconnectedAt: null, isDefault: true });
    expect(prisma.db.channel[0].integrationId).toBe(prisma.db.integration[0].id);

    await svc.sendInConversation("ws1", "cv", "hello");
    const [url, init] = fetchJson.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/pn-1/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN-2");
  });

  it("Zernio: disconnect the platform, reconnect the same account, reply works", async () => {
    const prisma = makeFakePrisma({
      workspace: [{ id: "ws1", zernioProfileId: "prof" }],
      integration: [integ({ provider: "zernio", pageId: "acc-1", accessToken: null })],
      channel: [chan({ provider: "zernio", externalId: "acc-1" })],
      contact: [contact],
      conversation: [conv({ externalId: "zc-1" })],
    });
    const client = {
      listAccounts: jest.fn(async () => [{ _id: "acc-1", platform: "whatsapp", displayName: "Shop" }]),
      sendMessage: jest.fn(async () => ({ id: "out" })),
    };
    const svc = zernio(prisma, client);

    await svc.disconnect("ws1", "whatsapp");
    expect(prisma.db.channel[0]).toMatchObject({ status: "disconnected", integrationId: null });

    await svc.syncAccounts("ws1");
    expect(prisma.db.channel).toHaveLength(1);
    expect(prisma.db.channel[0]).toMatchObject({ status: "active", statusReason: null, disconnectedAt: null });

    await svc.sendInDbConversation("ws1", "cv", "hello");
    expect(client.sendMessage).toHaveBeenCalledWith("zc-1", "acc-1", "hello", undefined);
  });

  it("a plain resync (same Integration, same account) does not revive a hub disconnect", async () => {
    const prisma = makeFakePrisma({
      workspace: [{ id: "ws1", zernioProfileId: "prof" }],
      integration: [integ({ provider: "zernio", pageId: "acc-1", accessToken: null })],
      channel: [chan({ provider: "zernio", externalId: "acc-1", status: "disconnected", statusReason: "disconnected_by_user", isDefault: false })],
    });
    const svc = zernio(prisma, { listAccounts: jest.fn(async () => [{ _id: "acc-1", platform: "whatsapp" }]) });
    await svc.syncAccounts("ws1");
    expect(prisma.db.channel[0].status).toBe("disconnected");
  });
});

describe("zernio re-auth with new account keeps existing threads replying and inbound in same conversation", () => {
  it("Zernio → Zernio: the Integration-linked channel follows the new account in place", async () => {
    const prisma = makeFakePrisma({
      workspace: [{ id: "ws1", zernioProfileId: "prof" }],
      integration: [integ({ provider: "zernio", pageId: "acc-old", accessToken: null })],
      channel: [chan({ provider: "zernio", externalId: "acc-old" })],
      contact: [contact],
      conversation: [conv({ externalId: "zc-old" })],
    });
    const client = {
      // Zernio still lists the revoked account first after a re-auth; the same
      // WhatsApp phone (strong identity) proves it is the same number.
      listAccounts: jest.fn(async () => [
        { _id: "acc-old", platform: "whatsapp", displayName: "Old name", needsReconnection: true, metadata: { phoneNumber: "+962790000099" } },
        { _id: "acc-new", platform: "whatsapp", displayName: "Shop", metadata: { phoneNumber: "962790000099" } },
      ]),
      sendMessage: jest.fn(async () => ({ id: "out" })),
    };
    const svc = zernio(prisma, client);
    await svc.syncAccounts("ws1");

    const linked = prisma.db.channel.find((c: { id: string }) => c.id === "chi_I1");
    expect(linked).toMatchObject({ externalId: "acc-new", integrationId: "I1", status: "active", isDefault: true });

    await svc.handleEvent(zEvent("acc-new", "zc-new", "m1"));
    expect(prisma.db.conversation).toHaveLength(1);
    expect(prisma.db.conversation[0]).toMatchObject({ id: "cv", channelId: "chi_I1", externalId: "zc-new" });

    await svc.sendInDbConversation("ws1", "cv", "hello");
    expect(client.sendMessage).toHaveBeenLastCalledWith("zc-new", "acc-new", "hello", undefined);
  });

  it("Meta → Zernio: the switched Integration keeps its channel and threads", async () => {
    const prisma = makeFakePrisma({
      workspace: [{ id: "ws1", zernioProfileId: "prof" }],
      integration: [integ()],
      channel: [chan()],
      contact: [contact],
      conversation: [conv()],
    });
    const client = {
      listAccounts: jest.fn(async () => [{ _id: "acc-z", platform: "whatsapp", displayName: "Shop" }]),
      listConversations: jest.fn(async () => [
        { id: "zc-z", accountId: "acc-z", platform: "whatsapp", participantId: WA },
      ]),
      sendMessage: jest.fn(async () => ({ id: "out" })),
    };
    const svc = zernio(prisma, client);
    await svc.syncAccounts("ws1");

    expect(prisma.db.channel).toHaveLength(1);
    expect(prisma.db.channel[0]).toMatchObject({ id: "chi_I1", provider: "zernio", externalId: "acc-z", status: "active" });

    await svc.sendInDbConversation("ws1", "cv", "hello");
    expect(client.sendMessage).toHaveBeenCalledWith("zc-z", "acc-z", "hello", undefined);

    await svc.handleEvent(zEvent("acc-z", "zc-z", "m1"));
    expect(prisma.db.conversation).toHaveLength(1);
  });

  it("deploy window: old code re-pointed Integration.pageId, the stale channel still sends from the Integration's account", async () => {
    const prisma = makeFakePrisma({
      integration: [integ({ provider: "zernio", pageId: "acc-new", accessToken: null })],
      channel: [chan({ provider: "zernio", externalId: "acc-old" })],
      contact: [contact],
      conversation: [conv({ externalId: "zc" })],
    });
    const client = { sendMessage: jest.fn(async () => ({ id: "out" })) };
    await zernio(prisma, client).sendInDbConversation("ws1", "cv", "hello");
    expect(client.sendMessage).toHaveBeenCalledWith("zc", "acc-new", "hello", undefined);
  });
});

describe("a number moved between workspaces routes to the live Integration (I1)", () => {
  it("W1's disconnected row never captures W2's first webhook", async () => {
    const prisma = makeFakePrisma({
      channel: [chan({ id: "w1", workspaceId: "ws1", integrationId: null, status: "disconnected", externalId: "pn-P" })],
      integration: [integ({ id: "I2", workspaceId: "ws2", pageId: "pn-P" })],
    });
    await meta(prisma).svc.handleWebhook(metaEvent("pn-P", "wamid.1"));
    expect(prisma.db.conversation).toHaveLength(1);
    expect(prisma.db.conversation[0].workspaceId).toBe("ws2");
  });

  it("an orphan active row (no Integration) loses to the workspace that holds the Integration", async () => {
    const prisma = makeFakePrisma({
      channel: [chan({ id: "w1", workspaceId: "ws1", integrationId: null, externalId: "pn-P" })],
      integration: [integ({ id: "I2", workspaceId: "ws2", pageId: "pn-P" })],
    });
    await meta(prisma).svc.handleWebhook(metaEvent("pn-P", "wamid.1"));
    expect(prisma.db.conversation[0].workspaceId).toBe("ws2");
  });

  it("connect mirrors the channel immediately", async () => {
    const prisma = makeFakePrisma();
    await meta(prisma).svc.connect("ws2", { phoneNumberId: "pn-9", wabaId: "w", accessToken: "t", verifyToken: "v" } as never);
    expect(prisma.db.channel).toEqual([
      expect.objectContaining({ workspaceId: "ws2", provider: "meta", externalId: "pn-9", status: "active", isDefault: true }),
    ]);
  });
});
