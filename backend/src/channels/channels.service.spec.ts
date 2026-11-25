import { ChannelsService } from "./channels.service";
import { ChannelTransportRegistry } from "./channel-transport";
import { channelErrorKey } from "./channel-errors";
import { makeFakePrisma } from "./test-prisma";

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
  config: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

function build(seed: Parameters<typeof makeFakePrisma>[0] = {}, zernio?: unknown) {
  const prisma = makeFakePrisma({ workspace: [{ id: "ws1", plan: "growth" }], ...seed });
  const realtime = { emitToWorkspace: jest.fn() };
  const transports = new ChannelTransportRegistry();
  const svc = new ChannelsService(prisma, transports, realtime as never, zernio as never);
  return { prisma, svc, realtime, transports };
}

describe("ChannelsService", () => {
  describe("default channel is unique per kind and must be active", () => {
    it("make default clears the other default of the kind in one transaction", async () => {
      const { prisma, svc, realtime } = build({ channel: [ch("A", { isDefault: true }), ch("B"), ch("F", { kind: "facebook", isDefault: true })] });
      const dto = await svc.update("ws1", "B", { isDefault: true });
      expect(dto.isDefault).toBe(true);
      const byId = Object.fromEntries(prisma.db.channel.map((c: { id: string; isDefault: boolean }) => [c.id, c.isDefault]));
      expect(byId).toEqual({ A: false, B: true, F: true });
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "channels.updated", { channelId: "B" });
    });

    it("refuses a non-active channel with 409 channels.default_requires_active", async () => {
      const { svc, prisma } = build({ channel: [ch("A", { isDefault: true }), ch("B", { status: "disconnected" })] });
      const err = await svc.update("ws1", "B", { isDefault: true }).catch((e) => e);
      expect(err.getStatus()).toBe(409);
      expect(channelErrorKey(err)).toBe("channels.default_requires_active");
      expect(prisma.db.channel[0].isDefault).toBe(true);
    });

    it("the first active channel of a kind becomes the default automatically", async () => {
      const { svc } = build();
      const first = await svc.createWebchat("ws1", { kind: "webchat", displayName: "Site", config: { allowedOrigins: ["https://a.example"] } });
      const second = await svc.createWebchat("ws1", { kind: "webchat", displayName: "Site 2", config: { allowedOrigins: ["https://b.example"] } });
      expect(first).toMatchObject({ kind: "webchat", provider: "native", isDefault: true, externalId: null });
      expect(second.isDefault).toBe(false);
    });

    it("disconnecting the default promotes the oldest other active channel", async () => {
      const { svc, prisma } = build({
        channel: [ch("A", { isDefault: true }), ch("B", { createdAt: new Date("2026-02-01") }), ch("C", { createdAt: new Date("2026-01-15") })],
      });
      const dto = await svc.disconnect("ws1", "A");
      expect(dto).toMatchObject({ status: "disconnected", isDefault: false });
      const A = prisma.db.channel.find((c: { id: string }) => c.id === "A");
      expect(A.disconnectedAt).toBeInstanceOf(Date);
      expect(prisma.db.channel.find((c: { id: string }) => c.id === "C").isDefault).toBe(true);
    });

    it("disconnect is soft: conversations keep their channelId and the provider hook runs", async () => {
      const { svc, prisma, transports } = build({
        channel: [ch("T", { kind: "telegram", provider: "telegram" })],
        conversation: [{ id: "cv", workspaceId: "ws1", channel: "telegram", channelId: "T", contactId: "c" }],
      });
      const disconnect = jest.fn(async () => {});
      transports.register({ provider: "telegram", sendText: jest.fn(), disconnect });
      await svc.disconnect("ws1", "T");
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(prisma.db.conversation[0].channelId).toBe("T");
      expect(prisma.db.channel).toHaveLength(1);
    });
  });

  describe("foreign channel id returns 404", () => {
    const seed = { channel: [ch("mine"), ch("theirs", { workspaceId: "ws2" })] };
    it.each([
      ["GET", (s: ChannelsService) => s.get("ws1", "theirs")],
      ["PATCH", (s: ChannelsService) => s.update("ws1", "theirs", { displayName: "x" })],
      ["DELETE", (s: ChannelsService) => s.disconnect("ws1", "theirs")],
    ])("%s", async (_m, call) => {
      const { svc, prisma } = build(seed);
      const err = await call(svc).catch((e: unknown) => e);
      expect((err as { getStatus(): number }).getStatus()).toBe(404);
      expect(channelErrorKey(err)).toBe("channels.not_found");
      expect(prisma.db.channel[1]).toMatchObject({ displayName: "theirs", status: "active" });
    });
  });

  it("list mirrors legacy integrations first and filters by kind", async () => {
    const { svc } = build({
      integration: [{ id: "i1", workspaceId: "ws1", platform: "facebook", provider: "meta", pageId: "p", pageName: "Page", createdAt: new Date() }],
      channel: [ch("A")],
    });
    const all = await svc.list("ws1");
    expect(all.map((c) => c.id).sort()).toEqual(["A", "chi_i1"]);
    expect((await svc.list("ws1", "facebook")).map((c) => c.id)).toEqual(["chi_i1"]);
  });

  it("limits returns the public base URL origin for the widget snippet and chat link (m1)", async () => {
    const prev = process.env.PUBLIC_BASE_URL;
    try {
      const { svc } = build();
      process.env.PUBLIC_BASE_URL = "https://api.example.com/";
      expect(await svc.limits("ws1", false)).toMatchObject({ publicBaseUrl: "https://api.example.com" });
      process.env.PUBLIC_BASE_URL = "not a url";
      expect(await svc.limits("ws1", false)).not.toHaveProperty("publicBaseUrl");
      process.env.PUBLIC_BASE_URL = "ftp://api.example.com";
      expect(await svc.limits("ws1", false)).not.toHaveProperty("publicBaseUrl");
      delete process.env.PUBLIC_BASE_URL;
      expect(await svc.limits("ws1", false)).not.toHaveProperty("publicBaseUrl");
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = prev;
    }
  });

  it("limits counts non-disconnected WhatsApp channels against the plan", async () => {
    const prev = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      const { svc } = build({ channel: [ch("A"), ch("B", { status: "disconnected" }), ch("F", { kind: "facebook" })] });
      expect(await svc.limits("ws1", false)).toEqual({ whatsapp: { used: 1, limit: 3, plan: "growth" } });
      expect(await svc.limits("ws1", true)).toMatchObject({ secretsEncryption: expect.stringMatching(/on|off/) });
    } finally {
      if (prev !== undefined) process.env.PUBLIC_BASE_URL = prev;
    }
  });

  it("sync runs the Zernio resync and the legacy mirror", async () => {
    const zernio = { syncAccounts: jest.fn(async () => ({ connected: [] })) };
    const { svc } = build({ integration: [{ id: "i1", workspaceId: "ws1", platform: "whatsapp", provider: "meta", pageId: "pn", pageName: "", createdAt: new Date() }] }, zernio);
    const out = await svc.sync("ws1");
    expect(zernio.syncAccounts).toHaveBeenCalledWith("ws1");
    expect(out.map((c) => c.id)).toEqual(["chi_i1"]);
  });

  it("webchat create only accepts kind webchat and strips unknown config keys", async () => {
    const { svc } = build();
    const dto = await svc.createWebchat("ws1", {
      kind: "webchat",
      displayName: "Site",
      config: { allowedOrigins: ["https://a.example"], botToken: "x", greeting: "Hi" },
    });
    expect(dto.config).toEqual({ allowedOrigins: ["https://a.example"], greeting: "Hi" });
  });
});

describe("web chat config validation (SP-19 T3)", () => {
  const OLD = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = OLD;
  });

  it("create and PATCH normalize origins and accept greeting, colour, position, askName and lang", async () => {
    const { svc } = build();
    const dto = await svc.createWebchat("ws1", {
      kind: "webchat",
      displayName: "Site",
      config: { allowedOrigins: ["https://Shop.example:443", "https://*.shop.com"], greeting: " Hi ", color: "#0F766E" },
    });
    expect(dto.config).toEqual({ allowedOrigins: ["https://shop.example", "https://*.shop.com"], greeting: "Hi", color: "#0F766E" });
    const next = await svc.update("ws1", dto.id, { config: { position: "start", askName: true, lang: "ar", greetingAr: "أهلًا" } });
    expect(next.config).toMatchObject({ allowedOrigins: ["https://shop.example", "https://*.shop.com"], position: "start", askName: true, lang: "ar", greetingAr: "أهلًا" });
  });

  it.each([
    [{ allowedOrigins: ["https://*.com"] }, "allowedOrigins"],
    [{ allowedOrigins: ["http://shop.example"] }, "allowedOrigins"],
    [{ greeting: "x".repeat(281) }, "greeting"],
    [{ color: "#abc" }, "color"],
    [{ position: "left" }, "position"],
    [{ lang: "fr" }, "lang"],
  ])("refuses %j with 400 channels.invalid_config {field: %s}", async (config, field) => {
    const { svc } = build();
    const err = await svc.createWebchat("ws1", { kind: "webchat", displayName: "Site", config }).catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.invalid_config");
    expect(err.getResponse().field).toBe(field);
  });

  it("production refuses http://localhost origins (https only)", async () => {
    process.env.NODE_ENV = "production";
    const { svc } = build();
    const err = await svc
      .createWebchat("ws1", { kind: "webchat", displayName: "Site", config: { allowedOrigins: ["http://localhost:5173"] } })
      .catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.invalid_config");
  });
});
