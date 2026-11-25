import { ZernioService } from "../integrations/zernio.service";
import { ChannelsService } from "./channels.service";
import { ChannelTransportRegistry } from "./channel-transport";
import { channelErrorKey } from "./channel-errors";
import { makeFakePrisma } from "./test-prisma";
import { ZernioChannelTransport } from "./zernio-transport";

/**
 * SP-19 T5 fix round 1 (I1): a Zernio channel the user disconnected in the hub
 * comes back through POST /channels/:id/reconnect while its account still
 * works at Zernio; otherwise the hub falls back to Zernio's OAuth link, which
 * is exempt from the number limit for that held channel.
 */

const integA = (over: Record<string, unknown> = {}) => ({
  id: "I-A",
  workspaceId: "ws1",
  platform: "whatsapp",
  provider: "zernio",
  pageId: "acc-A",
  pageName: "Shop A",
  accessToken: null,
  raw: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

const chan = (over: Record<string, unknown> = {}) => ({
  id: "chi_I-A",
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "zernio",
  externalId: "acc-A",
  displayName: "Shop A",
  phoneNumber: null,
  status: "disconnected",
  statusReason: "disconnected_by_user",
  disconnectedAt: new Date("2026-02-01"),
  isDefault: false,
  integrationId: "I-A",
  config: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

const account = (over: Record<string, unknown> = {}) => ({
  _id: "acc-A",
  platform: "whatsapp",
  displayName: "Shop A",
  isActive: true,
  platformStatus: "active",
  needsReconnection: false,
  metadata: {},
  ...over,
});

function build(plan: string, channels: unknown[], accounts: unknown[]) {
  const prisma = makeFakePrisma({
    workspace: [{ id: "ws1", plan, zernioProfileId: "prof" }],
    integration: [integA()],
    channel: channels,
  } as never);
  prisma.raw = prisma;
  const client = {
    isConfigured: () => true,
    listAccounts: jest.fn(async () => accounts),
    getConnectUrl: jest.fn(async () => ({ authUrl: "https://zernio.example/connect" })),
  };
  const realtime = { emitToWorkspace: jest.fn() };
  const zernio = new ZernioService(
    prisma,
    realtime as never,
    {} as never,
    client as never,
    { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) } as never,
    { enabled: false } as never,
    { isConfigured: () => false } as never,
  );
  const transports = new ChannelTransportRegistry();
  new ZernioChannelTransport(zernio, transports).onModuleInit();
  const hub = new ChannelsService(prisma, transports, realtime as never, zernio as never);
  return { prisma, client, zernio, hub, transports };
}

describe("zernio reconnect hook (I1)", () => {
  it("revives a hub-disconnected channel whose account Zernio lists as healthy", async () => {
    const { hub, prisma, client } = build("growth", [chan()], [account()]);
    const dto = await hub.reconnect("ws1", "chi_I-A");
    expect(client.listAccounts).toHaveBeenCalled();
    expect(dto).toMatchObject({ id: "chi_I-A", status: "active", statusReason: null, isDefault: true });
    expect(prisma.db.channel[0].disconnectedAt).toBeNull();
  });

  it("asks for Zernio re-auth when the account needs reconnection or is gone, and leaves the row alone", async () => {
    for (const accounts of [[account({ needsReconnection: true })], [account({ _id: "acc-OTHER" })]]) {
      const { hub, prisma } = build("growth", [chan()], accounts);
      const e = await hub.reconnect("ws1", "chi_I-A").catch((x: unknown) => x);
      expect(channelErrorKey(e)).toBe("channels.zernio_reauth_required");
      expect((e as { getStatus(): number }).getStatus()).toBe(409);
      expect(prisma.db.channel[0]).toMatchObject({ status: "disconnected", statusReason: "disconnected_by_user" });
    }
  });

  it("reviving a disconnected WhatsApp number takes a slot: 409 limit_reached at the plan limit", async () => {
    const other = chan({ id: "live", integrationId: null, externalId: "acc-B", status: "active", statusReason: null, disconnectedAt: null, isDefault: true });
    const { hub, prisma } = build("free", [chan(), other], [account(), account({ _id: "acc-B", displayName: "Shop B" })]);
    const e = await hub.reconnect("ws1", "chi_I-A").catch((x: unknown) => x);
    expect(channelErrorKey(e)).toBe("channels.limit_reached");
    expect(prisma.db.channel.find((c: { id: string }) => c.id === "chi_I-A").status).toBe("disconnected");
  });

  it("the zernio transport sends nothing itself (Zernio keeps its own send routes)", async () => {
    const { transports, prisma } = build("growth", [chan()], []);
    const t = transports.get("zernio")!;
    const e = await Promise.resolve()
      .then(() => t.sendText(prisma.db.channel[0], {} as never, "x"))
      .catch((x: unknown) => x);
    expect(channelErrorKey(e)).toBe("channels.transport_unavailable");
  });
});

describe("zernio connect link for a reconnect is exempt from the limit (I1)", () => {
  const live = chan({ id: "live", integrationId: null, externalId: "acc-B", status: "active", statusReason: null, disconnectedAt: null, isDefault: true });

  it("a user-disconnected held channel passed as reconnectChannelId gets the link on a full free plan", async () => {
    const { zernio, client } = build("free", [chan(), live], []);
    await expect(zernio.getConnectUrl("ws1", "whatsapp", { reconnectChannelId: "chi_I-A" })).resolves.toEqual({
      authUrl: "https://zernio.example/connect",
    });
    expect(client.getConnectUrl).toHaveBeenCalledTimes(1);
  });

  it("without reconnectChannelId the same link stays gated", async () => {
    const { zernio } = build("free", [chan(), live], []);
    const e = await zernio.getConnectUrl("ws1", "whatsapp").catch((x: unknown) => x);
    expect(channelErrorKey(e)).toBe("channels.limit_reached");
  });

  it("an unknown, foreign, non-Zernio or other-platform channel id is 404", async () => {
    const foreign = chan({ id: "foreign", workspaceId: "ws2", integrationId: null, externalId: "acc-F" });
    const meta = chan({ id: "meta", provider: "meta", integrationId: null, externalId: "pn-M" });
    const insta = chan({ id: "insta", kind: "instagram", integrationId: null, externalId: "acc-I" });
    const { zernio, client } = build("free", [chan(), live, foreign, meta, insta], []);
    for (const id of ["nope", "foreign", "meta", "insta"]) {
      const e = await zernio.getConnectUrl("ws1", "whatsapp", { reconnectChannelId: id }).catch((x: unknown) => x);
      expect(channelErrorKey(e)).toBe("channels.not_found");
    }
    expect(client.getConnectUrl).not.toHaveBeenCalled();
  });
});
