import { ConversationsService } from "./conversations.service";
import { staffSenderId } from "./message-sender";
import { ChannelResolver } from "../channels/channel-resolver.service";
import { ChannelTransportRegistry } from "../channels/channel-transport";
import { makeFakePrisma } from "../channels/test-prisma";
import { ZernioService } from "../integrations/zernio.service";
import { WhatsAppService } from "../integrations/whatsapp.service";
import { WhatsAppController } from "../integrations/whatsapp.controller";
import { ZernioController } from "../integrations/zernio.controller";
import { SendWhatsappTemplateExecutor } from "../workflows/executors/send-whatsapp-template.executor";

/**
 * SP-11 ruling 4: every staff message sent from the inbox records its sender
 * in `Message.sentById`; AI replies and workflow sends do not (campaign sends
 * write no Message row at all). Real services over the in-memory Prisma.
 */

const ME = { userId: "u-member" };
const channel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "zernio",
  externalId: `acc-${id}`,
  displayName: id,
  status: "active",
  isDefault: true,
  integrationId: null,
  secretsEnc: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

function world(provider: "zernio" | "meta") {
  return makeFakePrisma({
    channel: [
      provider === "zernio"
        ? channel("Z")
        : channel("M", { provider: "meta", externalId: "pn-M", secretsEnc: JSON.stringify({ accessToken: "TOKEN" }) }),
    ],
    contact: [{ id: "c1", workspaceId: "ws1", externalId: "962790000001", phone: "+962790000001" }],
    conversation: [
      {
        id: "cv",
        workspaceId: "ws1",
        contactId: "c1",
        channel: "whatsapp",
        channelId: provider === "zernio" ? "Z" : "M",
        externalId: "zc-1",
        assigneeId: null,
        unread: 0,
        updatedAt: new Date("2026-01-01"),
      },
    ],
    template: [],
    message: [],
  });
}

function zernio(prisma: ReturnType<typeof makeFakePrisma>) {
  const client = { sendMessage: jest.fn(async () => ({ id: "out-1" })), sendTemplateMessage: jest.fn(async () => ({ id: "out-2" })) };
  return new ZernioService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    client as never,
    { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) } as never,
    { enabled: false } as never,
    { isConfigured: () => false } as never,
  );
}

function meta(prisma: ReturnType<typeof makeFakePrisma>) {
  const svc = new WhatsAppService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    { onInboundMessage: jest.fn(async () => {}) } as never,
    { isConfigured: () => false } as never,
  );
  jest
    .spyOn(svc as unknown as { fetchJson: () => Promise<unknown> }, "fetchJson")
    .mockResolvedValue({ messages: [{ id: "wamid.out" }] });
  return svc;
}

const handoff = { humanReplied: jest.fn(async () => {}) } as never;
const perm = { assertConversationVisible: jest.fn(async () => {}) } as never;
const senders = (prisma: ReturnType<typeof makeFakePrisma>) =>
  prisma.db.message.map((m: { from: string; sentById?: string | null }) => [m.from, m.sentById ?? null]);

describe("Message.sentById writers (SP-11)", () => {
  it("staff sends record the sender", async () => {
    // Inbox text and template through Zernio (the WhatsApp transport in use).
    const pz = world("zernio");
    const z = new ZernioController(zernio(pz), handoff, perm);
    await z.sendInDbConversation("ws1", "cv", { message: "hello" } as never, ME);
    await z.sendTemplateInDbConversation("ws1", "cv", { name: "promo", language: "en" } as never, ME);
    expect(senders(pz)).toEqual([
      ["human", "u-member"],
      ["human", "u-member"],
    ]);

    // Inbox text and template through Meta.
    const pm = world("meta");
    const w = new WhatsAppController(meta(pm), handoff, perm);
    await w.sendInConversation("ws1", "cv", { message: "hello" } as never, ME);
    await w.sendTemplateInConversation("ws1", "cv", { name: "promo", language: "en" } as never, ME);
    expect(senders(pm)).toEqual([
      ["human", "u-member"],
      ["human", "u-member"],
    ]);

    // POST /conversations/:id/messages and /send (channel transports).
    const pc = world("zernio");
    pc.db.channel.push(channel("T", { kind: "telegram", provider: "telegram", externalId: "bot", isDefault: false }));
    pc.db.conversation.push({ id: "tg", workspaceId: "ws1", contactId: "c1", channel: "telegram", channelId: "T", assigneeId: null, updatedAt: new Date() });
    const transports = new ChannelTransportRegistry();
    transports.register({ provider: "telegram", sendText: jest.fn(async () => ({ providerMessageId: "tg:1" })) } as never);
    const convs = new ConversationsService(
      pc,
      { emitToWorkspace: jest.fn() } as never,
      { queueReply: jest.fn() } as never,
      undefined,
      { conversationScope: jest.fn(async () => ({})) } as never,
      new ChannelResolver(pc),
      transports,
    );
    await convs.addMessage("ws1", "cv", { from: "human", body: "typed" }, ME);
    await convs.sendViaChannel("ws1", "tg", "via telegram", ME);
    // A customer row through the same route records nobody.
    await convs.addMessage("ws1", "cv", { from: "them", body: "customer" }, ME);
    expect(senders(pc)).toEqual([
      ["human", "u-member"],
      ["human", "u-member"],
      ["them", null],
    ]);
  });

  it("AI replies, workflow template sends and unattributed sessions store null", async () => {
    // The AI reply path (Zernio, from "ai") and the AI's Meta fallback (no actor).
    const pz = world("zernio");
    await zernio(pz).sendInDbConversation("ws1", "cv", "AI answer", undefined, undefined, "ai");
    const pm = world("meta");
    await meta(pm).sendInConversation("ws1", "cv", "AI answer via Meta");
    expect(senders(pz)).toEqual([["ai", null]]);
    expect(senders(pm)).toEqual([["human", null]]);
    // Even if an actor were passed, an "ai" row never records one.
    const pz2 = world("zernio");
    await zernio(pz2).sendInDbConversation("ws1", "cv", "AI", undefined, undefined, "ai", undefined, "u-member");
    expect(senders(pz2)).toEqual([["ai", null]]);

    // Workflow "send WhatsApp template" on both transports.
    for (const provider of ["zernio", "meta"] as const) {
      const p = world(provider);
      const exec = new SendWhatsappTemplateExecutor(p, zernio(p), meta(p), new ChannelResolver(p));
      await exec.execute("ws1", { name: "promo", language: "en", variables: [] } as never, {
        trigger: { conversation: { id: "cv", channel: "whatsapp" } },
      } as never);
      expect({ provider, senders: senders(p) }).toEqual({ provider, senders: [["human", null]] });
    }

    // Super-admin / impersonation sessions have no member row: unattributed.
    expect(staffSenderId({ userId: "admin", bypass: true })).toBeUndefined();
    expect(staffSenderId(undefined)).toBeUndefined();
    expect(staffSenderId(ME)).toBe("u-member");
    const pb = world("zernio");
    await new ZernioController(zernio(pb), handoff, perm).sendInDbConversation("ws1", "cv", { message: "x" } as never, {
      userId: "admin",
      bypass: true,
    });
    expect(senders(pb)).toEqual([["human", null]]);
  });
});
