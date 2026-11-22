import { ConversationsService } from "./conversations.service";
import { ChannelResolver } from "../channels/channel-resolver.service";
import { ChannelTransportRegistry } from "../channels/channel-transport";
import { makeFakePrisma } from "../channels/test-prisma";

const ch = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "zernio",
  externalId: `acc-${id}`,
  displayName: id,
  status: "active",
  isDefault: false,
  integrationId: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});
const conv = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  contactId: "c1",
  channel: "whatsapp",
  channelId: null,
  pinned: false,
  assigneeId: null,
  preview: "",
  updatedAt: new Date("2026-01-01"),
  ...over,
});

function build(seed: Parameters<typeof makeFakePrisma>[0], scope: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma(seed);
  const perm = {
    conversationScope: jest.fn(async () => scope),
    assertConversationVisible: jest.fn(async () => {}),
  };
  const realtime = { emitToWorkspace: jest.fn() };
  const transports = new ChannelTransportRegistry();
  const svc = new ConversationsService(
    prisma,
    realtime as never,
    { queueReply: jest.fn() } as never,
    undefined,
    perm as never,
    new ChannelResolver(prisma),
    transports,
  );
  return { prisma, svc, perm, realtime, transports };
}

describe("number filter composes with conversationScope", () => {
  const seed = {
    channel: [ch("A", { integrationId: "int-a", isDefault: true }), ch("B")],
    conversation: [
      conv("b-mine", { channelId: "B", assigneeId: "u1" }),
      conv("b-other", { channelId: "B", assigneeId: "u2" }),
      conv("a-mine", { channelId: "A", assigneeId: "u1" }),
      conv("legacy-mine", { assigneeId: "u1" }), // effective A
      conv("fb-mine", { channel: "facebook", assigneeId: "u1" }),
    ],
  };

  it("an assigned-only agent filtering by B sees only their B conversations", async () => {
    const { svc } = build(seed, { assigneeId: "u1" });
    const rows = await svc.list("ws1", { userId: "u1" } as never, { channelIds: ["B"] });
    expect(rows.map((r) => r.id)).toEqual(["b-mine"]);
  });

  it("the filter matches the effective channel of legacy rows", async () => {
    const { svc } = build(seed, { assigneeId: "u1" });
    const rows = await svc.list("ws1", { userId: "u1" } as never, { channelIds: ["A"] });
    expect(rows.map((r) => r.id).sort()).toEqual(["a-mine", "legacy-mine"]);
  });

  it("the payload carries the effective channelId and channelProvider", async () => {
    const { svc } = build(seed);
    const rows = await svc.list("ws1");
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by["legacy-mine"]).toMatchObject({ channelId: "A", channelProvider: "zernio" });
    expect(by["b-other"]).toMatchObject({ channelId: "B", channelProvider: "zernio" });
    expect(by["fb-mine"]).toMatchObject({ channelId: null, channelProvider: null });
    expect(rows).toHaveLength(5);
  });
});

describe("POST /conversations/:id/send", () => {
  const seed = () => ({
    channel: [ch("T", { kind: "telegram", provider: "telegram", externalId: "bot" }), ch("Z")],
    contact: [{ id: "c1", workspaceId: "ws1", externalId: "chat-1" }],
    conversation: [conv("tg", { channel: "telegram", channelId: "T" }), conv("z", { channelId: "Z" })],
  });

  it("delivers through the provider's transport and records the message", async () => {
    const { svc, prisma, transports, realtime } = build(seed());
    const sendText = jest.fn(async (..._a: unknown[]) => ({ providerMessageId: "tg:T:9" }));
    const delivered = jest.fn();
    transports.register({ provider: "telegram", sendText, delivered });
    const out = await svc.sendViaChannel("ws1", "tg", "hello", { userId: "u1" } as never);
    expect(sendText.mock.calls[0][0]).toMatchObject({ id: "T" });
    expect(sendText.mock.calls[0][1]).toMatchObject({ id: "tg", contact: { externalId: "chat-1" } });
    expect(out.message).toMatchObject({ from: "human", body: "hello", metaMessageId: "tg:T:9" });
    expect(prisma.db.conversation[0]).toMatchObject({ preview: "hello", lastFrom: "human" });
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "inbox.activity", expect.objectContaining({ channelId: "T", conversationId: "tg" }));
  });

  it("zernio/meta threads keep their own routes (400 channels.transport_unavailable)", async () => {
    const { svc } = build(seed());
    await expect(svc.sendViaChannel("ws1", "z", "x")).rejects.toMatchObject({ response: { message: "channels.transport_unavailable" } });
  });

  it("a hidden conversation is 404 before anything is sent", async () => {
    const { svc, transports } = build(seed(), { assigneeId: "someone-else" });
    const sendText = jest.fn();
    transports.register({ provider: "telegram", sendText });
    await expect(svc.sendViaChannel("ws1", "tg", "x", { userId: "u1" } as never)).rejects.toMatchObject({ status: 404 });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("a disconnected channel is refused", async () => {
    const s = seed();
    s.channel[0].status = "disconnected";
    const { svc, transports } = build(s);
    const sendText = jest.fn();
    transports.register({ provider: "telegram", sendText });
    await expect(svc.sendViaChannel("ws1", "tg", "x")).rejects.toMatchObject({ response: { message: "channels.disconnected" } });
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe("inbox list: lastInboundAt for every channel (one grouped query)", () => {
  const at = (iso: string) => new Date(iso);
  const msg = (id: string, conversationId: string, from: string, iso: string) => ({
    id, workspaceId: "ws1", conversationId, from, body: "x", createdAt: at(iso), t: "", agent: null,
  });
  const seed = () => ({
    channel: [ch("W", { isDefault: true }), ch("C", { kind: "webchat", provider: "native" }), ch("T", { kind: "telegram", provider: "telegram" })],
    conversation: [
      conv("wa", { channelId: "W" }),
      conv("web", { channel: "webchat", channelId: "C" }),
      conv("tg", { channel: "telegram", channelId: "T" }),
      conv("ig", { channel: "instagram" }),
    ],
    message: [
      msg("m1", "wa", "them", "2026-11-22T08:00:00Z"),
      msg("m2", "wa", "them", "2026-11-22T09:00:00Z"),
      msg("m3", "wa", "human", "2026-11-22T09:30:00Z"),
      msg("m4", "web", "them", "2026-11-22T07:00:00Z"),
      msg("m5", "web", "ai", "2026-11-22T07:05:00Z"),
      msg("m6", "tg", "human", "2026-11-22T06:00:00Z"),
      msg("m7", "ig", "them", "2026-11-21T23:00:00Z"),
    ],
  });

  it("is the newest customer message per conversation (null without one); the WhatsApp window stays WhatsApp-only", async () => {
    const { svc, prisma } = build(seed());
    const groupBy = jest.spyOn(prisma.message, "groupBy");
    const rows = (await svc.list("ws1")) as Array<Record<string, unknown>>;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect((by.wa.lastInboundAt as Date).toISOString()).toBe("2026-11-22T09:00:00.000Z");
    expect((by.web.lastInboundAt as Date).toISOString()).toBe("2026-11-22T07:00:00.000Z");
    expect(by.tg.lastInboundAt).toBeNull();
    expect((by.ig.lastInboundAt as Date).toISOString()).toBe("2026-11-21T23:00:00.000Z");
    // JSON carries it as an ISO timestamp.
    expect(JSON.parse(JSON.stringify(by.web)).lastInboundAt).toBe("2026-11-22T07:00:00.000Z");
    expect(by.wa).toHaveProperty("waWindowOpen");
    expect(by.web).not.toHaveProperty("waWindowOpen");
    expect(by.ig).not.toHaveProperty("waWindowOpen");
  });

  it("an assign, read, label or pin (updatedAt) does not move it", async () => {
    const s = seed();
    s.conversation[1] = conv("web", { channel: "webchat", channelId: "C", updatedAt: new Date("2026-11-22T11:59:00Z"), assigneeId: "u1" });
    const { svc } = build(s);
    const rows = (await svc.list("ws1")) as Array<Record<string, unknown>>;
    const web = rows.find((r) => r.id === "web")!;
    expect((web.lastInboundAt as Date).toISOString()).toBe("2026-11-22T07:00:00.000Z");
  });
});
