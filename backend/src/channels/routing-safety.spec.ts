import { NotFoundException } from "@nestjs/common";
import { ZernioService } from "../integrations/zernio.service";
import { ConversationsService } from "../conversations/conversations.service";
import { ChannelsService } from "./channels.service";
import { ChannelResolver } from "./channel-resolver.service";
import { ChannelTransportRegistry } from "./channel-transport";
import { channelErrorKey } from "./channel-errors";
import { defaultZernioWhatsappAccountId } from "./default-channel";
import { mirrorZernioAccounts } from "./zernio-mirror";
import { makeFakePrisma } from "./test-prisma";

/** SP-19 fix round 1: I2–I5 and the minors. */

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
const zInteg = { id: "I1", workspaceId: "ws1", platform: "whatsapp", provider: "zernio", pageId: "acc-1", pageName: "x", createdAt: new Date() };

function zernio(prisma: ReturnType<typeof makeFakePrisma>, client: Record<string, unknown> = {}) {
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

function hub(seed: Parameters<typeof makeFakePrisma>[0] = {}) {
  const prisma = makeFakePrisma({ workspace: [{ id: "ws1", plan: "pro" }], ...seed });
  return { prisma, svc: new ChannelsService(prisma, new ChannelTransportRegistry(), { emitToWorkspace: jest.fn() } as never) };
}

describe("a hub-disconnected channel is honoured by every Integration fallback (I2, R9)", () => {
  const seed = () =>
    makeFakePrisma({
      integration: [zInteg],
      channel: [ch("chi_I1", { externalId: "acc-1", integrationId: "I1", status: "disconnected", statusReason: "disconnected_by_user" })],
    });

  it("templates and null-sender campaigns get no account", async () => {
    expect(await defaultZernioWhatsappAccountId(seed(), "ws1")).toBeNull();
  });

  it("the live Zernio send by accountId rejects it", async () => {
    const client = { sendMessage: jest.fn() };
    await expect(zernio(seed(), client).sendInConversation("ws1", "zc", "acc-1", "hi")).rejects.toBeInstanceOf(NotFoundException);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("the Integration fallback still works while nothing is mirrored", async () => {
    expect(await defaultZernioWhatsappAccountId(makeFakePrisma({ integration: [zInteg] }), "ws1")).toBe("acc-1");
  });
});

describe("an empty or malformed account list never mass-disconnects (I3)", () => {
  it("skips the mark-missing step", async () => {
    const prisma = makeFakePrisma({ channel: [ch("A", { isDefault: true }), ch("B")] });
    await mirrorZernioAccounts(prisma, "ws1", [], []);
    await mirrorZernioAccounts(prisma, "ws1", [{} as never, null as never], []);
    expect(prisma.db.channel.map((c: { status: string }) => c.status)).toEqual(["active", "active"]);
    expect(prisma.db.channel[0].isDefault).toBe(true);
  });
});

describe("history backfill resolves threads like inbound (I4)", () => {
  const seed = () =>
    makeFakePrisma({
      workspace: [{ id: "ws1", zernioProfileId: "prof" }],
      channel: [ch("A", { isDefault: true })],
      contact: [{ id: "c1", workspaceId: "ws1", externalSource: "whatsapp", externalId: "9627", phone: "+9627" }],
      conversation: [{ id: "cvA", workspaceId: "ws1", contactId: "c1", channel: "whatsapp", channelId: "A", externalId: "zc-a", updatedAt: new Date() }],
    });
  const client = (accountId: string) => ({
    listConversations: jest.fn(async () => [{ id: "zc-b", platform: "whatsapp", participantId: "9627", accountId }]),
    getMessages: jest.fn(async () => [{ id: "hm1", direction: "incoming", message: "old B message", createdAt: "2026-01-02T00:00:00Z" }]),
  });

  it("an account with no channel is skipped, never merged into A's thread", async () => {
    const prisma = seed();
    const res = await zernio(prisma, client("acc-unknown")).backfillHistory("ws1");
    expect(prisma.db.message).toHaveLength(0);
    expect(prisma.db.conversation).toHaveLength(1);
    expect(res.conversationsCreated).toBe(0);
  });

  it("number B's history goes into B's own conversation", async () => {
    const prisma = seed();
    prisma.db.channel.push(ch("B"));
    await zernio(prisma, client("acc-B")).backfillHistory("ws1");
    const b = prisma.db.conversation.find((c: { channelId: string }) => c.channelId === "B");
    expect(b).toBeTruthy();
    expect(prisma.db.message.every((m: { conversationId: string }) => m.conversationId === b.id)).toBe(true);
  });
});

describe("default races map to 409, never 500 (I5)", () => {
  const p2002 = () => Object.assign(new Error("unique"), { code: "P2002" });

  it("make-default losing the race returns 409 channels.default_conflict and rolls back", async () => {
    const { prisma, svc } = hub({ channel: [ch("A", { isDefault: true }), ch("B")] });
    prisma.channel.update.mockImplementationOnce(() => Promise.reject(p2002()));
    const err = await svc.update("ws1", "B", { isDefault: true }).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(channelErrorKey(err)).toBe("channels.default_conflict");
    expect(prisma.db.channel.find((c: { id: string }) => c.id === "A").isDefault).toBe(true);
  });

  it("a concurrent first webchat create falls back to non-default", async () => {
    const { prisma, svc } = hub();
    prisma.channel.create.mockImplementationOnce(() => Promise.reject(p2002()));
    const dto = await svc.createWebchat("ws1", { kind: "webchat", displayName: "Site", config: { allowedOrigins: ["https://a.example"] } });
    expect(dto.isDefault).toBe(false);
  });
});

describe("minors", () => {
  it("M1: the only default of a kind cannot be unset (400 channels.default_required)", async () => {
    const { svc, prisma } = hub({ channel: [ch("A", { isDefault: true })] });
    const err = await svc.update("ws1", "A", { isDefault: false }).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(channelErrorKey(err)).toBe("channels.default_required");
    expect(prisma.db.channel[0].isDefault).toBe(true);
  });

  it.each([
    [["*"]],
    [["https://a.example/path"]],
    [["ftp://a.example"]],
    ["https://a.example"],
    [Array.from({ length: 21 }, (_, i) => `https://s${i}.example`)],
  ])("M2: allowedOrigins %j is rejected with 400 channels.invalid_config", async (allowedOrigins) => {
    const { svc } = hub();
    const err = await svc
      .createWebchat("ws1", { kind: "webchat", displayName: "Site", config: { allowedOrigins } as never })
      .catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.invalid_config");
  });

  it("M2: valid http(s) origins are accepted", async () => {
    const { svc } = hub();
    const dto = await svc.createWebchat("ws1", {
      kind: "webchat",
      displayName: "Site",
      config: { allowedOrigins: ["https://shop.example", "http://localhost:5173"] },
    });
    expect(dto.config).toEqual({ allowedOrigins: ["https://shop.example", "http://localhost:5173"] });
  });

  it("M3: touchInbound stamps lastInboundAt without bumping updatedAt", async () => {
    const prisma = makeFakePrisma({ channel: [ch("A")] });
    const before = prisma.db.channel[0].updatedAt;
    await new ChannelResolver(prisma).touchInbound("A");
    expect(prisma.db.channel[0].lastInboundAt).toBeInstanceOf(Date);
    expect(prisma.db.channel[0].updatedAt).toBe(before);
  });

  it("M4: GET /conversations mirrors legacy rows at most once a minute per workspace", async () => {
    const prisma = makeFakePrisma();
    const svc = new ConversationsService(prisma, { emitToWorkspace: jest.fn() } as never, { queueReply: jest.fn() } as never);
    await svc.list("ws-m4");
    await svc.list("ws-m4");
    expect(prisma.integration.findMany).toHaveBeenCalledTimes(1);
  });
});
