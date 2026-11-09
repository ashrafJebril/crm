import { ConversationsService } from "../../conversations/conversations.service";
import { ChannelResolver } from "../channel-resolver.service";
import { ChannelTransportRegistry } from "../channel-transport";
import { channelErrorKey } from "../channel-errors";
import { InboundSinkService } from "../inbound-sink.service";
import { makeFakePrisma } from "../test-prisma";
import { langFromAcceptLanguage, toWidgetMessage, WebchatService } from "./webchat.service";

const wc = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "webchat",
  provider: "native",
  externalId: null,
  displayName: "Site",
  status: "active",
  isDefault: true,
  config: { allowedOrigins: ["https://shop.example"] },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(40);
});

function build(seed: Record<string, unknown[]> = {}) {
  const prisma = makeFakePrisma({ channel: [wc("W1")], workspace: [{ id: "ws1", lang: "en" }], ...seed } as never);
  prisma.raw = prisma;
  const realtime = { emitToWorkspace: jest.fn(), emitToWidgetVisitor: jest.fn() };
  const sink = new InboundSinkService(prisma, realtime as never, { onInboundMessage: jest.fn(async () => {}) } as never);
  const transports = new ChannelTransportRegistry();
  const svc = new WebchatService(prisma, sink, transports, realtime as never);
  svc.onModuleInit();
  const perm = { conversationScope: jest.fn(async () => ({})) };
  const conversations = new ConversationsService(
    prisma, realtime as never, { queueReply: jest.fn() } as never, undefined, perm as never, new ChannelResolver(prisma), transports,
  );
  return { prisma, realtime, svc, transports, conversations, perm };
}

describe("agent reply reaches visitor room", () => {
  it("POST /conversations/:id/send on a web chat thread writes one human Message and emits widget.message to widget:<channelId>:<visitorId>", async () => {
    const b = build();
    const W1 = b.prisma.db.channel[0];
    const { visitorId } = await b.svc.postMessage(W1, { body: "hi, is this open?" });
    const conv = b.prisma.db.conversation[0];
    b.realtime.emitToWidgetVisitor.mockClear();

    const out = await b.conversations.sendViaChannel("ws1", conv.id, "Yes, we are open", { userId: "u1" } as never);
    expect(out.message).toMatchObject({ from: "human", body: "Yes, we are open", deliveryStatus: "sent" });
    expect(out.message.metaMessageId).toMatch(/^wc:W1:/);
    expect(b.prisma.db.message.filter((m: { from: string }) => m.from === "human")).toHaveLength(1);
    expect(b.realtime.emitToWidgetVisitor).toHaveBeenCalledTimes(1);
    expect(b.realtime.emitToWidgetVisitor).toHaveBeenCalledWith("W1", visitorId, "widget.message", {
      id: out.message.id,
      from: "agent",
      body: "Yes, we are open",
      at: expect.any(String),
    });
  });

  it("the visitor sees the reply in their history; nothing else of the workspace", async () => {
    const b = build();
    const W1 = b.prisma.db.channel[0];
    const v = await b.svc.postMessage(W1, { body: "q" });
    const conv = b.prisma.db.conversation[0];
    await b.conversations.sendViaChannel("ws1", conv.id, "a", { userId: "u1" } as never);
    // an internal row type the visitor must never see
    b.prisma.db.message.push({ id: "n1", workspaceId: "ws1", conversationId: conv.id, from: "note", body: "internal", createdAt: new Date() });
    const { items } = await b.svc.listMessages(W1, { visitorId: v.visitorId, visitorToken: v.visitorToken });
    expect(items.map((i) => [i.from, i.body])).toEqual([
      ["visitor", "q"],
      ["agent", "a"],
    ]);
  });

  it("a disconnected web chat channel refuses the reply (409) and emits nothing", async () => {
    const b = build();
    const W1 = b.prisma.db.channel[0];
    await b.svc.postMessage(W1, { body: "q" });
    W1.status = "disconnected";
    b.realtime.emitToWidgetVisitor.mockClear();
    const err = await b.conversations.sendViaChannel("ws1", b.prisma.db.conversation[0].id, "a", { userId: "u1" } as never).catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.disconnected");
    expect(b.realtime.emitToWidgetVisitor).not.toHaveBeenCalled();
  });

  it("a hidden conversation is 404 for the viewer and nothing is emitted", async () => {
    const b = build();
    await b.svc.postMessage(b.prisma.db.channel[0], { body: "q" });
    b.perm.conversationScope.mockResolvedValue({ assigneeId: "someone-else" } as never);
    b.realtime.emitToWidgetVisitor.mockClear();
    await expect(b.conversations.sendViaChannel("ws1", b.prisma.db.conversation[0].id, "x", { userId: "u2" } as never)).rejects.toMatchObject({ status: 404 });
    expect(b.realtime.emitToWidgetVisitor).not.toHaveBeenCalled();
  });

  it("the native transport refuses a conversation with no visitor id", async () => {
    const b = build();
    const t = b.transports.get("native")!;
    const conv = { id: "c", workspaceId: "ws1", channel: "webchat", channelId: "W1", externalId: null, contactId: "k", contact: null };
    const err = await Promise.resolve(t.sendText(b.prisma.db.channel[0], conv, "x")).catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.not_connected");
  });

  it("native reconnect revives a disconnected web chat channel through POST /channels/:id/reconnect (m5)", async () => {
    const { ChannelsService } = await import("../channels.service");
    const b = build({ channel: [wc("W1", { status: "disconnected", statusReason: "disconnected_by_user", disconnectedAt: new Date(), isDefault: false })] });
    const hub = new ChannelsService(b.prisma, b.transports, b.realtime as never);
    const dto = await hub.reconnect("ws1", "W1");
    expect(dto).toMatchObject({ id: "W1", status: "active", statusReason: null, isDefault: true });
    expect(b.prisma.db.channel[0].disconnectedAt).toBeNull();
    expect(b.realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "channels.updated", { channelId: "W1" });
    // an active channel is left as it is
    const again = await hub.reconnect("ws1", "W1");
    expect(again.status).toBe("active");
  });

  it("registers the native transport once", () => {
    const b = build();
    expect(b.transports.providers()).toEqual(["native"]);
    b.svc.onModuleInit();
    expect(b.transports.providers()).toEqual(["native"]);
  });
});

describe("helpers", () => {
  it("maps rows to the visitor shape", () => {
    const at = new Date("2026-11-09T10:00:00Z");
    expect(toWidgetMessage({ id: "m", from: "them", body: "b", createdAt: at })).toEqual({ id: "m", from: "visitor", body: "b", at: at.toISOString() });
    expect(toWidgetMessage({ id: "m", from: "ai", body: "b", createdAt: at }).from).toBe("agent");
  });

  it("reads en/ar from Accept-Language", () => {
    expect(langFromAcceptLanguage("ar-JO,ar;q=0.9,en;q=0.8")).toBe("ar");
    expect(langFromAcceptLanguage("fr-FR,en;q=0.5")).toBe("en");
    expect(langFromAcceptLanguage("fr")).toBeNull();
    expect(langFromAcceptLanguage(undefined)).toBeNull();
  });

  it("public config never echoes invalid stored values", () => {
    const b = build();
    const cfg = b.svc.publicConfig(wc("W1", { config: { color: "red;x", position: "middle", askName: "yes", lang: "fr", greeting: 7 } }) as never);
    expect(cfg).toEqual({ displayName: "Site", greeting: null, greetingAr: null, color: null, position: "end", askName: false, lang: null });
  });
});
