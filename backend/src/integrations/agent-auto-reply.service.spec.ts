/* eslint-disable @typescript-eslint/no-explicit-any */
import { makeFakePrisma } from "../channels/test-prisma";
import { ChannelTransportRegistry } from "../channels/channel-transport";
import { InboundSinkService } from "../channels/inbound-sink.service";
import { channelError } from "../channels/channel-errors";
import { AgentReplyGate, invalidateAgentGate } from "../agent/agent-reply-gate";
import { AgentAutoReplyService } from "./agent-auto-reply.service";

const WS = "ws1";
const flush = () => new Promise((r) => setImmediate(r));

function world(opts: { kind?: "telegram" | "webchat"; conv?: Record<string, unknown>; contact?: Record<string, unknown> } = {}) {
  const kind = opts.kind ?? "telegram";
  const provider = kind === "telegram" ? "telegram" : "native";
  const channel = { id: "ch1", workspaceId: WS, kind, provider, status: "active", isDefault: true };
  const prisma: any = makeFakePrisma({
    workspace: [{ id: WS, name: "Acme", timezone: "Asia/Riyadh" }],
    channel: [channel],
    contact: [{ id: "ct1", workspaceId: WS, name: "Ali", phone: null, externalId: "chat-42", externalSource: kind, tags: "[]", marketingOptOut: false, ...(opts.contact ?? {}) }],
    conversation: [
      {
        id: "cv1", workspaceId: WS, contactId: "ct1", channelId: "ch1", channel: kind, externalId: null,
        aiEnabled: true, aiPausedAt: null, escalated: false, status: "human", unread: 1, version: 0,
        preview: "", lastAt: "now", lastFrom: "them", updatedAt: new Date(), ...(opts.conv ?? {}),
      },
    ],
    message: [],
    agentSettings: [],
    tag: [],
  } as never);
  const realtime = { emitToWorkspace: jest.fn(), emitToWidgetVisitor: jest.fn() };
  const resolver = { forSend: jest.fn(async () => channel) };
  const registry = new ChannelTransportRegistry();
  const telegram = { provider: "telegram", sendText: jest.fn(async () => ({ providerMessageId: "tg:ch1:555" })) };
  const native = {
    provider: "native",
    sendText: jest.fn(async () => ({ providerMessageId: null })),
    delivered: jest.fn(async (_c: unknown, _t: unknown, message: { id: string }) => realtime.emitToWidgetVisitor("ch1", "visitor-1", "widget.message", { id: message.id })),
  };
  registry.register(telegram);
  registry.register(native);
  const lAgent = { enabled: true, ask: jest.fn(async () => ({ answer: "Hello! How can I help?" }) as { answer: string; imageUrl?: string } | null) };
  const gate = new AgentReplyGate(prisma);
  const paymentLock = { isLocked: jest.fn(async () => false) };
  const sink = new InboundSinkService(prisma, realtime as never, { onInboundMessage: jest.fn() } as never, undefined, { onInbound: jest.fn() } as never);
  const svc = new AgentAutoReplyService(prisma, realtime as never, resolver as never, registry, lAgent as never, gate, paymentLock as never, sink);
  svc.onModuleInit();
  invalidateAgentGate();
  return { prisma, db: prisma.db, realtime, resolver, telegram, native, lAgent, gate, paymentLock, sink, svc, channel };
}

const aiMessages = (w: ReturnType<typeof world>) => w.db.message.filter((m: any) => m.from === "ai");
const inbound = (w: ReturnType<typeof world>, text = "Do you deliver?", id = "tg:ch1:1") =>
  w.sink.record({ workspaceId: WS, channel: w.channel as never, externalSource: w.channel.kind, externalId: "chat-42", contactName: "Ali", text, providerMessageId: id, at: new Date() });

describe("AgentAutoReplyService (SP-22 Task 2)", () => {
  afterEach(() => invalidateAgentGate());

  it("telegram inbound gets one agent reply through its transport", async () => {
    const w = world();
    const r = await inbound(w);
    expect(r.duplicate).toBe(false);
    expect(await w.svc.last).toBe("sent");
    // Stored first, then asked once, keyed by the CRM conversation id (ruling 11).
    expect(w.db.message.find((m: any) => m.from === "them")?.body).toBe("Do you deliver?");
    expect(w.lAgent.ask).toHaveBeenCalledTimes(1);
    expect(w.lAgent.ask).toHaveBeenCalledWith(WS, { externalId: r.conversationId, message: "Do you deliver?" });
    expect(w.telegram.sendText).toHaveBeenCalledTimes(1);
    expect((w.telegram.sendText.mock.calls[0] as unknown[])[2]).toBe("Hello! How can I help?");
    expect(aiMessages(w)).toEqual([expect.objectContaining({ conversationId: r.conversationId, body: "Hello! How can I help?", metaMessageId: "tg:ch1:555" })]);
    const conv = w.db.conversation.find((c: any) => c.id === r.conversationId);
    expect(conv.aiPausedAt).toBeNull(); // the AI's own reply never pauses the AI
    expect(conv.lastFrom).toBe("ai");
    expect(w.realtime.emitToWorkspace).toHaveBeenCalledWith(WS, "inbox.activity", expect.objectContaining({ conversationId: r.conversationId }));
    // A duplicate inbound is not answered again.
    await inbound(w);
    await flush();
    expect(w.lAgent.ask).toHaveBeenCalledTimes(1);
  });

  it("webchat reply is delivered to the visitor socket", async () => {
    const w = world({ kind: "webchat" });
    await inbound(w, "Hi", "wc:1");
    expect(await w.svc.last).toBe("sent");
    const msg = aiMessages(w)[0];
    expect(w.native.delivered).toHaveBeenCalledTimes(1);
    expect(w.realtime.emitToWidgetVisitor).toHaveBeenCalledWith("ch1", "visitor-1", "widget.message", { id: msg.id });
  });

  it("no auto-reply when paused, disabled, locked or disconnected", async () => {
    const cases: Array<[string, (w: ReturnType<typeof world>) => void, string]> = [
      ["paused", (w) => (w.db.conversation[0].aiPausedAt = new Date()), "conversation_off"],
      ["ai off", (w) => (w.db.conversation[0].aiEnabled = false), "conversation_off"],
      ["escalated", (w) => (w.db.conversation[0].escalated = true), "conversation_off"],
      ["locked", (w) => w.paymentLock.isLocked.mockResolvedValue(true), "locked"],
      ["lock lookup fails", (w) => w.paymentLock.isLocked.mockRejectedValue(new Error("db")), "failed"],
      ["disconnected", (w) => w.resolver.forSend.mockRejectedValue(channelError("channels.disconnected", { channelId: "ch1" })), "channel_unavailable"],
      ["L_API_URL unset", (w) => (w.lAgent.enabled = false), "l_disabled"],
    ];
    for (const [name, setup, outcome] of cases) {
      const w = world();
      setup(w);
      await inbound(w);
      expect({ name, outcome: await w.svc.last }).toEqual({ name, outcome });
      expect({ name, sends: w.telegram.sendText.mock.calls.length + w.native.sendText.mock.calls.length, ai: aiMessages(w).length }).toEqual({ name, sends: 0, ai: 0 });
      if (name !== "disconnected") expect({ name, ask: w.lAgent.ask.mock.calls.length }).toEqual({ name, ask: 0 });
    }
  });

  it("a human reply during the l turn wins (re-checked at send time)", async () => {
    const w = world();
    w.lAgent.ask.mockImplementation(async () => {
      w.db.conversation[0].aiPausedAt = new Date(); // a staff reply landed meanwhile
      return { answer: "Too late" };
    });
    await inbound(w);
    expect(await w.svc.last).toBe("taken_over");
    expect(w.telegram.sendText).not.toHaveBeenCalled();
  });

  it("sp20 gate blocks the reply", async () => {
    // The real gate: the emergency stop comes first.
    const w = world();
    w.db.agentSettings.push({ id: "s", workspaceId: WS, stoppedAt: new Date(), hoursMode: "always", excludedTagIds: [] });
    await inbound(w);
    expect(await w.svc.last).toBe("gated");
    expect(w.lAgent.ask).not.toHaveBeenCalled();
    // A gate that fails closed.
    const w2 = world();
    w2.prisma.agentSettings.findUnique = jest.fn(async () => {
      throw new Error("db down");
    });
    await inbound(w2);
    expect(await w2.svc.last).toBe("gated");
    expect(w2.telegram.sendText).not.toHaveBeenCalled();
    // An excluded tag blocks it (the owner's way to silence the AI for a person).
    const w3 = world({ contact: { tags: JSON.stringify(["no-ai"]) } });
    w3.db.tag.push({ id: "tg1", workspaceId: WS, name: "no-ai" });
    w3.db.agentSettings.push({ id: "s3", workspaceId: WS, stoppedAt: null, hoursMode: "always", excludedTagIds: ["tg1"] });
    await inbound(w3);
    expect(await w3.svc.last).toBe("gated");
  });

  it("agent answer is validated before sending", async () => {
    const w = world();
    for (const answer of ["", "   ", 42 as never]) {
      w.lAgent.ask.mockResolvedValueOnce({ answer });
      await inbound(w, "q", `tg:ch1:${String(answer)}x`);
      expect(await w.svc.last).toBe("invalid_answer");
    }
    expect(w.telegram.sendText).not.toHaveBeenCalled();

    w.lAgent.ask.mockResolvedValueOnce({ answer: `${"Long sentence here. ".repeat(600)}\u0000` });
    await inbound(w, "q", "tg:ch1:long");
    expect(await w.svc.last).toBe("sent");
    const sent = (w.telegram.sendText.mock.calls[0] as unknown[])[2] as string;
    expect(sent.length).toBeLessThanOrEqual(4000);
    expect(sent.endsWith("…")).toBe(true);
    expect(sent).not.toContain("\u0000");

    // An image that is not an approved media of this workspace is dropped (text only).
    w.lAgent.ask.mockResolvedValueOnce({ answer: "Here is our menu.", imageUrl: "https://evil.example.com/x.jpg" });
    await inbound(w, "menu?", "tg:ch1:img");
    expect(await w.svc.last).toBe("sent");
    expect((w.telegram.sendText.mock.calls[1] as unknown[])[2]).toBe("Here is our menu.");
  });

  it("opted-out contact still gets a reply to their own message", async () => {
    // Ruling 10: marketing opt-out does not block a reply to an inbound message.
    const w = world({ contact: { marketingOptOut: true } });
    await inbound(w);
    expect(await w.svc.last).toBe("sent");
    expect(w.telegram.sendText).toHaveBeenCalledTimes(1);
  });
});

describe("SP-22 Task 2 wiring", () => {
  it("IntegrationsModule provides the auto-reply; it asks Nest only for global or same-module services (no cycle)", async () => {
    const { MODULE_METADATA } = await import("@nestjs/common/constants");
    const { IntegrationsModule } = await import("./integrations.module");
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, IntegrationsModule)).toContain(AgentAutoReplyService);
    const params = Reflect.getMetadata("design:paramtypes", AgentAutoReplyService) as Array<{ name: string }>;
    expect(params.map((p) => p.name)).toEqual([
      "PrismaService", "RealtimeService", "ChannelResolver", "ChannelTransportRegistry", "LAgentService", "AgentReplyGate", "PaymentLockService", "InboundSinkService",
    ]);
  });
});
