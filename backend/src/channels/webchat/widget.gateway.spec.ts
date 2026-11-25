import { makeFakePrisma } from "../test-prisma";
import { mintVisitor } from "./visitor-token";
import { WidgetGateway, widgetRoom } from "./widget.gateway";
import { WidgetRateLimiter } from "./widget-rate-limit.guard";
import { RealtimeService } from "../../realtime/realtime.service";

const wc = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "webchat",
  provider: "native",
  status: "active",
  config: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(40);
  process.env.PUBLIC_BASE_URL = "https://api.example.com";
});

function build() {
  const prisma = makeFakePrisma({ channel: [wc("W1"), wc("W2", { status: "disconnected" }), wc("T1", { kind: "telegram", provider: "telegram" })] } as never);
  prisma.raw = prisma;
  const realtime = new RealtimeService({ server: undefined } as never);
  const gw = new WidgetGateway(prisma, realtime, new WidgetRateLimiter(() => 0));
  return { gw, realtime };
}

function socket(handshake: Record<string, unknown>) {
  return { handshake, join: jest.fn(async () => {}), disconnect: jest.fn() };
}

const headers = (over: Record<string, string> = {}) => ({ host: "api.example.com", "x-forwarded-proto": "https", ...over });

describe("widget gateway rejects bad token or foreign origin", () => {
  it("a valid visitor from the API origin joins only its own room", async () => {
    const { gw } = build();
    const v = mintVisitor("W1");
    const s = socket({ headers: headers({ origin: "https://api.example.com" }), auth: { channelId: "W1", ...v } });
    await gw.handleConnection(s as never);
    expect(s.join).toHaveBeenCalledWith(`widget:W1:${v.visitorId}`);
    expect(s.disconnect).not.toHaveBeenCalled();
  });

  it("no Origin header (non-browser / same-origin polling) still needs a valid token", async () => {
    const { gw } = build();
    const v = mintVisitor("W1");
    const ok = socket({ headers: headers(), auth: { channelId: "W1", ...v } });
    await gw.handleConnection(ok as never);
    expect(ok.join).toHaveBeenCalled();
  });

  it.each([
    ["foreign origin", (v: { visitorId: string; visitorToken: string }) => ({ headers: headers({ origin: "https://evil.example" }), auth: { channelId: "W1", ...v } })],
    ["an allowed embedding site is still not the API origin", (v: { visitorId: string; visitorToken: string }) => ({ headers: headers({ origin: "https://shop.example" }), auth: { channelId: "W1", ...v } })],
    ["bad token", (v: { visitorId: string; visitorToken: string }) => ({ headers: headers(), auth: { channelId: "W1", visitorId: v.visitorId, visitorToken: "A".repeat(43) } })],
    ["missing token", (v: { visitorId: string }) => ({ headers: headers(), auth: { channelId: "W1", visitorId: v.visitorId } })],
    ["token of another channel", (v: { visitorId: string; visitorToken: string }) => ({ headers: headers(), auth: { channelId: "W1", ...mintVisitor("W9"), visitorId: v.visitorId } })],
    ["no auth", () => ({ headers: headers() })],
    ["disconnected channel", () => ({ headers: headers(), auth: { channelId: "W2", ...mintVisitor("W2") } })],
    ["not a web chat channel", () => ({ headers: headers(), auth: { channelId: "T1", ...mintVisitor("T1") } })],
    ["unknown channel", () => ({ headers: headers(), auth: { channelId: "nope", ...mintVisitor("nope") } })],
  ])("%s → disconnected, joins nothing", async (_name, hs) => {
    const { gw } = build();
    const s = socket(hs(mintVisitor("W1")) as Record<string, unknown>);
    await gw.handleConnection(s as never);
    expect(s.join).not.toHaveBeenCalled();
    expect(s.disconnect).toHaveBeenCalledWith(true);
  });

  it("handshakes are rate limited per IP", async () => {
    const { gw } = build();
    const v = mintVisitor("W1");
    let joined = 0;
    for (let i = 0; i < 125; i++) {
      const s = socket({ headers: headers({ "fly-client-ip": "9.9.9.9" }), auth: { channelId: "W1", ...v } });
      await gw.handleConnection(s as never);
      joined += s.join.mock.calls.length;
    }
    expect(joined).toBe(120);
  });

  it("afterInit attaches the namespace so emitToWidgetVisitor reaches the room", () => {
    const { gw, realtime } = build();
    const emit = jest.fn();
    const ns = { to: jest.fn(() => ({ emit })) };
    gw.afterInit(ns as never);
    realtime.emitToWidgetVisitor("W1", "V", "widget.message", { id: "m" });
    expect(ns.to).toHaveBeenCalledWith(widgetRoom("W1", "V"));
    expect(emit).toHaveBeenCalledWith("widget.message", { id: "m" });
  });
});
