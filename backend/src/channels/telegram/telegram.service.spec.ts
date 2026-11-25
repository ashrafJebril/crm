import { Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { TelegramService } from "./telegram.service";
import { TelegramApiError } from "./telegram.client";
import { ChannelTransportRegistry } from "../channel-transport";
import { ChannelsService } from "../channels.service";
import { InboundSinkService } from "../inbound-sink.service";
import { ChannelResolver } from "../channel-resolver.service";
import { channelErrorKey } from "../channel-errors";
import { makeFakePrisma } from "../test-prisma";
import { ConversationsService } from "../../conversations/conversations.service";

const TOKEN = "987654:AAF-very_secret_bot_token_123";
const BOT = { id: 987654, is_bot: true, first_name: "Shop Bot", username: "shop_bot" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const tg = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "telegram",
  provider: "telegram",
  externalId: String(BOT.id),
  displayName: "Shop Bot",
  status: "active",
  isDefault: true,
  integrationId: null,
  config: { botUsername: "shop_bot" },
  secretsEnc: JSON.stringify({ botToken: TOKEN }),
  webhookSecretHash: sha("old-secret"),
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

function fakeClient() {
  return {
    getMe: jest.fn(async (_t: string) => ({ ...BOT })),
    setWebhook: jest.fn(async (_t: string, _a: { url: string; secretToken: string }) => {}),
    deleteWebhook: jest.fn(async (_t: string) => {}),
    sendMessage: jest.fn(async (_t: string, _c: string, _x: string) => ({ message_id: 501 })),
    getFile: jest.fn(async (_t: string, _f: string) => ({ file_id: "f", file_path: "photos/p.jpg", file_size: 10 })),
    downloadFile: jest.fn(async (_t: string, _p: string) => Buffer.from([1, 2, 3])),
  };
}

function build(seed: Parameters<typeof makeFakePrisma>[0] = {}) {
  const prisma = makeFakePrisma(seed);
  prisma.raw = prisma;
  const client = fakeClient();
  const realtime = { emitToWorkspace: jest.fn() };
  const pipeline = { onInboundMessage: jest.fn(async () => {}) };
  const sink = new InboundSinkService(prisma, realtime as never, pipeline as never);
  const transports = new ChannelTransportRegistry();
  const media = { ingestBuffer: jest.fn(async () => ({ id: "media-1" })) };
  const svc = new TelegramService(prisma, client as never, sink, transports, realtime as never, media as never);
  svc.onModuleInit();
  const channels = new ChannelsService(prisma, transports, realtime as never);
  return { prisma, client, realtime, sink, transports, media, svc, channels };
}

const ENV = { ...process.env };
beforeEach(() => {
  process.env.PUBLIC_BASE_URL = "https://crm.example.com";
  delete process.env.TOKEN_ENC_KEY;
  process.env.NODE_ENV = "test";
});
afterAll(() => {
  process.env = ENV;
});

describe("POST /channels/telegram (provision)", () => {
  it("creates an active channel, stores the token encrypted-at-rest and only a hash of the secret", async () => {
    process.env.TOKEN_ENC_KEY = "k".repeat(40);
    const { svc, prisma, client, realtime } = build();
    const dto = await svc.provision("ws1", { botToken: TOKEN });
    expect(dto).toMatchObject({
      kind: "telegram",
      provider: "telegram",
      externalId: "987654",
      displayName: "Shop Bot",
      status: "active",
      isDefault: true,
      config: { botUsername: "shop_bot" },
    });
    const row = prisma.db.channel[0];
    expect(row.secretsEnc).toMatch(/^enc:v1:/);
    expect(row.secretsEnc).not.toContain(TOKEN);
    const [, args] = client.setWebhook.mock.calls[0];
    expect(args.url).toBe(`https://crm.example.com/api/webhooks/telegram/${row.id}`);
    expect(args.secretToken).toMatch(/^[0-9a-f]{64}$/);
    expect(row.webhookSecretHash).toBe(sha(args.secretToken));
    expect(JSON.stringify(row)).not.toContain(args.secretToken);
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "channels.updated", { channelId: row.id });
  });

  it("uses the given displayName", async () => {
    const { svc } = build();
    await expect(svc.provision("ws1", { botToken: TOKEN, displayName: "  Support  " })).resolves.toMatchObject({ displayName: "Support" });
  });

  it("bad bot token creates no channel", async () => {
    const { svc, prisma, client } = build();
    client.getMe.mockRejectedValue(new TelegramApiError("Telegram getMe failed: Unauthorized", 401));
    const err = await svc.provision("ws1", { botToken: TOKEN }).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(channelErrorKey(err)).toBe("channels.telegram_invalid_token");
    expect(prisma.db.channel).toHaveLength(0);
    expect(client.setWebhook).not.toHaveBeenCalled();
  });

  it("a malformed token is refused without calling Telegram", async () => {
    const { svc, client, prisma } = build();
    const err = await svc.provision("ws1", { botToken: "not-a-token" }).catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.telegram_invalid_token");
    expect(client.getMe).not.toHaveBeenCalled();
    expect(prisma.db.channel).toHaveLength(0);
  });

  it("needs an https PUBLIC_BASE_URL (400 channels.telegram_needs_public_url)", async () => {
    for (const v of [undefined, "http://localhost:3001"]) {
      if (v === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = v;
      const { svc, client, prisma } = build();
      const err = await svc.provision("ws1", { botToken: TOKEN }).catch((e) => e);
      expect(channelErrorKey(err)).toBe("channels.telegram_needs_public_url");
      expect(client.getMe).not.toHaveBeenCalled();
      expect(prisma.db.channel).toHaveLength(0);
    }
  });

  it("production without TOKEN_ENC_KEY refuses to store the token (R5)", async () => {
    process.env.NODE_ENV = "production";
    const { svc, prisma, client } = build();
    const err = await svc.provision("ws1", { botToken: TOKEN }).catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.encryption_unavailable");
    expect(prisma.db.channel).toHaveLength(0);
    expect(client.setWebhook).not.toHaveBeenCalled();
  });

  it("setWebhook failure parks channel in error", async () => {
    const { svc, prisma, client } = build();
    client.setWebhook.mockRejectedValue(new TelegramApiError("Telegram setWebhook failed: bad url", 400));
    const dto = await svc.provision("ws1", { botToken: TOKEN });
    expect(dto).toMatchObject({ status: "error", statusReason: "telegram_webhook_failed", isDefault: false });
    const row = prisma.db.channel[0];
    expect(row.status).toBe("error");
    // The token is kept so POST /channels/:id/reconnect can retry.
    expect(JSON.parse(row.secretsEnc)).toEqual({ botToken: TOKEN });
  });

  it("an active bot in this workspace is 409 channels.already_connected", async () => {
    const { svc, client } = build({ channel: [tg("T1")] });
    const err = await svc.provision("ws1", { botToken: TOKEN }).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(channelErrorKey(err)).toBe("channels.already_connected");
    expect(client.setWebhook).not.toHaveBeenCalled();
  });

  it("an active bot in another workspace is 409 channels.connected_elsewhere", async () => {
    const { svc, client, prisma } = build({ channel: [tg("T9", { workspaceId: "ws2" })] });
    const err = await svc.provision("ws1", { botToken: TOKEN }).catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.connected_elsewhere");
    expect(client.setWebhook).not.toHaveBeenCalled();
    expect(prisma.db.channel).toHaveLength(1);
  });

  it("reconnecting the same bot reactivates its disconnected row (R9: history kept)", async () => {
    const { svc, prisma } = build({
      channel: [tg("T1", { status: "disconnected", statusReason: "disconnected_by_user", disconnectedAt: new Date(), isDefault: false })],
      conversation: [{ id: "cv1", workspaceId: "ws1", contactId: "c1", channel: "telegram", channelId: "T1" }],
    });
    const dto = await svc.provision("ws1", { botToken: TOKEN });
    expect(dto).toMatchObject({ id: "T1", status: "active", statusReason: null, isDefault: true });
    expect(prisma.db.channel).toHaveLength(1);
    expect(prisma.db.channel[0].disconnectedAt).toBeNull();
    expect(prisma.db.channel[0].webhookSecretHash).not.toBe(sha("old-secret"));
    expect(prisma.db.conversation[0].channelId).toBe("T1");
  });

  it("an errored row of the same bot is re-provisioned in place with the new token", async () => {
    const { svc, prisma } = build({ channel: [tg("T1", { status: "error", statusReason: "telegram_webhook_failed", secretsEnc: "{}" })] });
    const dto = await svc.provision("ws1", { botToken: TOKEN });
    expect(dto).toMatchObject({ id: "T1", status: "active" });
    expect(JSON.parse(prisma.db.channel[0].secretsEnc)).toEqual({ botToken: TOKEN });
  });

  it("bot token never in DTO or logs", async () => {
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(() => {}),
    );
    const staticSpies = (["log", "warn", "error", "debug"] as const).map((m) =>
      jest.spyOn(Logger, m).mockImplementation(() => {}),
    );
    const consoleSpies = (["log", "warn", "error", "info"] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const { svc, client, channels } = build();
      // a success, a webhook failure (logged), a reconnect, a send failure, a teardown failure
      const ok = await svc.provision("ws1", { botToken: TOKEN, displayName: "A" });
      client.setWebhook.mockRejectedValueOnce(new TelegramApiError(`Telegram setWebhook failed: oops /bot${TOKEN}/x`, 400));
      const reconnected = await channels.reconnect("ws1", ok.id);
      client.deleteWebhook.mockRejectedValueOnce(new Error(`ECONNRESET https://api.telegram.org/bot${TOKEN}/deleteWebhook`));
      const gone = await channels.disconnect("ws1", ok.id);
      const listed = await channels.list("ws1");
      const blob = JSON.stringify([ok, reconnected, gone, listed]);
      expect(blob).not.toContain(TOKEN);
      expect(blob).not.toContain("AAF-very_secret");
      expect(blob).not.toMatch(/secretsEnc|webhookSecretHash|botToken/);

      const logged = [...spies, ...staticSpies, ...consoleSpies].flatMap((s) => s.mock.calls.flat()).map(String).join("\n");
      expect(logged).toContain("bot***"); // the failures were logged, masked
      expect(logged).not.toContain("AAF-very_secret");
    } finally {
      [...spies, ...staticSpies, ...consoleSpies].forEach((s) => s.mockRestore());
    }
  });
});

describe("POST /channels/:id/reconnect", () => {
  it("rotates the secret, re-registers the webhook and reactivates", async () => {
    const { svc, channels, client, prisma } = build({
      channel: [tg("T1", { status: "disconnected", statusReason: "disconnected_by_user", disconnectedAt: new Date(), isDefault: false })],
    });
    const dto = await channels.reconnect("ws1", "T1");
    expect(dto).toMatchObject({ id: "T1", status: "active", statusReason: null, isDefault: true });
    const [token, args] = client.setWebhook.mock.calls[0];
    expect(token).toBe(TOKEN);
    expect(args.url).toBe("https://crm.example.com/api/webhooks/telegram/T1");
    expect(prisma.db.channel[0].webhookSecretHash).toBe(sha(args.secretToken));
    expect(prisma.db.channel[0].disconnectedAt).toBeNull();
    expect(svc).toBeDefined();
  });

  it("a revoked token is 400 channels.telegram_invalid_token and the row is untouched", async () => {
    const { channels, client, prisma } = build({ channel: [tg("T1", { status: "error" })] });
    client.getMe.mockRejectedValue(new TelegramApiError("Telegram getMe failed: Unauthorized", 401));
    const err = await channels.reconnect("ws1", "T1").catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.telegram_invalid_token");
    expect(prisma.db.channel[0]).toMatchObject({ status: "error", webhookSecretHash: sha("old-secret") });
  });

  it("refuses when the bot is active in another workspace", async () => {
    const { channels, client } = build({
      channel: [tg("T1", { status: "disconnected" }), tg("T9", { workspaceId: "ws2" })],
    });
    const err = await channels.reconnect("ws1", "T1").catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.connected_elsewhere");
    expect(client.setWebhook).not.toHaveBeenCalled();
  });

  it("a setWebhook failure parks the channel in error", async () => {
    const { channels, client } = build({ channel: [tg("T1", { status: "disconnected", isDefault: false })] });
    client.setWebhook.mockRejectedValue(new TelegramApiError("Telegram setWebhook failed: x", 400));
    await expect(channels.reconnect("ws1", "T1")).resolves.toMatchObject({ status: "error", statusReason: "telegram_webhook_failed" });
  });

  it("foreign channel id → 404", async () => {
    const { channels, client } = build({ channel: [tg("T9", { workspaceId: "ws2" })] });
    const err = await channels.reconnect("ws1", "T9").catch((e) => e);
    expect(err.getStatus()).toBe(404);
    expect(channelErrorKey(err)).toBe("channels.not_found");
    expect(client.getMe).not.toHaveBeenCalled();
  });

  it("a provider without a reconnect flow is 400 channels.transport_unavailable", async () => {
    const { channels } = build({ channel: [tg("Z", { kind: "whatsapp", provider: "zernio", externalId: "acc" })] });
    const err = await channels.reconnect("ws1", "Z").catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.transport_unavailable");
  });
});

describe("disconnect", () => {
  it("disconnect deletes webhook", async () => {
    const { channels, client, prisma } = build({ channel: [tg("T1")] });
    const dto = await channels.disconnect("ws1", "T1");
    expect(client.deleteWebhook).toHaveBeenCalledWith(TOKEN);
    expect(dto.status).toBe("disconnected");
    expect(prisma.db.channel[0].status).toBe("disconnected");
  });

  it("a teardown failure still disconnects (best effort)", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const { channels, client } = build({ channel: [tg("T1")] });
    client.deleteWebhook.mockRejectedValue(new TelegramApiError("Telegram deleteWebhook failed: HTTP 502", 502));
    await expect(channels.disconnect("ws1", "T1")).resolves.toMatchObject({ status: "disconnected" });
    warn.mockRestore();
  });
});

describe("telegram transport", () => {
  const conv = {
    id: "cv1",
    workspaceId: "ws1",
    channel: "telegram",
    channelId: "T1",
    externalId: null,
    contactId: "c1",
    contact: { id: "c1", externalId: "555", phone: null, name: "Sara" },
  };

  it("reply sends via bot to chat id", async () => {
    const { transports, client } = build({ channel: [tg("T1")] });
    const t = transports.get("telegram")!;
    const out = await t.sendText(tg("T1") as never, conv, "hello");
    expect(client.sendMessage).toHaveBeenCalledWith(TOKEN, "555", "hello");
    expect(out).toEqual({ providerMessageId: "tg:T1:555:501" });
  });

  it("reply via POST /conversations/:id/send records tg:<channelId>:<chat>:<message_id>", async () => {
    const seed = {
      channel: [tg("T1")],
      contact: [{ id: "c1", workspaceId: "ws1", externalId: "555", externalSource: "telegram", name: "Sara" }],
      conversation: [{ id: "cv1", workspaceId: "ws1", contactId: "c1", channel: "telegram", channelId: "T1", assigneeId: "u1" }],
    };
    const { prisma, client, transports, realtime } = build(seed);
    const perm = { conversationScope: jest.fn(async () => ({})) };
    const conversations = new ConversationsService(
      prisma, realtime as never, { queueReply: jest.fn() } as never, undefined, perm as never, new ChannelResolver(prisma), transports,
    );
    const out = await conversations.sendViaChannel("ws1", "cv1", "hi there", { userId: "u1" } as never);
    expect(client.sendMessage).toHaveBeenCalledWith(TOKEN, "555", "hi there");
    expect(out.message).toMatchObject({ from: "human", metaMessageId: "tg:T1:555:501", deliveryStatus: "sent" });

    // viewer scope: a hidden conversation is 404 and nothing reaches Telegram
    perm.conversationScope.mockResolvedValue({ assigneeId: "someone-else" });
    client.sendMessage.mockClear();
    await expect(conversations.sendViaChannel("ws1", "cv1", "x", { userId: "u2" } as never)).rejects.toMatchObject({ status: 404 });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("a Telegram send failure is 502 channels.telegram_send_failed without the token", async () => {
    const { transports, client } = build({ channel: [tg("T1")] });
    client.sendMessage.mockRejectedValue(new TelegramApiError(`Telegram sendMessage failed: Forbidden: bot was blocked by the user`, 403));
    const err = await transports.get("telegram")!.sendText(tg("T1") as never, conv, "x").catch((e) => e);
    expect(err.getStatus()).toBe(502);
    expect(channelErrorKey(err)).toBe("channels.telegram_send_failed");
    expect(JSON.stringify(err.getResponse())).not.toContain(TOKEN);
  });

  it("a conversation with no chat id cannot be sent", async () => {
    const { transports, client } = build({ channel: [tg("T1")] });
    const err = await transports
      .get("telegram")!
      .sendText(tg("T1") as never, { ...conv, contact: null }, "x")
      .catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.telegram_send_failed");
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

describe("ingestUpdate", () => {
  const update = (message: Record<string, unknown> | undefined, update_id = 1) => ({ update_id, ...(message ? { message } : {}) });
  const msg = (over: Record<string, unknown> = {}) => ({
    message_id: 10,
    date: 1_762_675_200,
    chat: { id: 555, type: "private", first_name: "Sara" },
    from: { id: 555, is_bot: false, first_name: "Sara", last_name: "Ali", username: "sara" },
    text: "hello",
    ...over,
  });

  it("records a private text message keyed by the Telegram user id", async () => {
    const { svc, prisma } = build({ channel: [tg("T1")] });
    await svc.ingestUpdate(tg("T1") as never, update(msg()));
    expect(prisma.db.contact).toHaveLength(1);
    expect(prisma.db.contact[0]).toMatchObject({ externalSource: "telegram", externalId: "555", name: "Sara Ali" });
    expect(prisma.db.conversation[0]).toMatchObject({ channelId: "T1", channel: "telegram" });
    expect(prisma.db.message[0]).toMatchObject({ from: "them", body: "hello", metaMessageId: "tg:T1:555:10" });
  });

  it("falls back to @username for the name", async () => {
    const { svc, prisma } = build({ channel: [tg("T1")] });
    await svc.ingestUpdate(tg("T1") as never, update(msg({ from: { id: 555, is_bot: false, first_name: "", username: "sara" } })));
    expect(prisma.db.contact[0].name).toBe("@sara");
  });

  it("the same message_id from two different chats is two messages", async () => {
    const { svc, prisma } = build({ channel: [tg("T1")] });
    await svc.ingestUpdate(tg("T1") as never, update(msg()));
    await svc.ingestUpdate(
      tg("T1") as never,
      update(msg({ chat: { id: 777, type: "private" }, from: { id: 777, is_bot: false, first_name: "Omar" } }), 2),
    );
    expect(prisma.db.message).toHaveLength(2);
  });

  it("ignores groups, bots and non-message updates", async () => {
    const { svc, prisma } = build({ channel: [tg("T1")] });
    await svc.ingestUpdate(tg("T1") as never, update(msg({ chat: { id: -100, type: "group" } })));
    await svc.ingestUpdate(tg("T1") as never, update(msg({ from: { id: 9, is_bot: true, first_name: "b" } })));
    await svc.ingestUpdate(tg("T1") as never, { update_id: 3, edited_message: msg() });
    await svc.ingestUpdate(tg("T1") as never, null);
    await svc.ingestUpdate(tg("T1") as never, "garbage");
    expect(prisma.db.message).toHaveLength(0);
  });

  it("a photo is downloaded, re-hosted and shown as [photo]", async () => {
    const { svc, prisma, client, media } = build({ channel: [tg("T1")] });
    await svc.ingestUpdate(
      tg("T1") as never,
      update(msg({ text: undefined, photo: [{ file_id: "small", file_size: 5 }, { file_id: "big", file_size: 10 }] })),
    );
    expect(client.getFile).toHaveBeenCalledWith(TOKEN, "big");
    expect(media.ingestBuffer).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws1", mimeType: "image/jpeg" }));
    expect(prisma.db.message[0]).toMatchObject({ body: "[photo]", attach: "media-1" });
  });

  it("a photo caption is the text", async () => {
    const { svc, prisma } = build({ channel: [tg("T1")] });
    await svc.ingestUpdate(tg("T1") as never, update(msg({ text: undefined, caption: "look", photo: [{ file_id: "big" }] })));
    expect(prisma.db.message[0]).toMatchObject({ body: "look", attach: "media-1" });
  });

  it("a non-image document is a [document] placeholder without download", async () => {
    const { svc, prisma, client } = build({ channel: [tg("T1")] });
    await svc.ingestUpdate(
      tg("T1") as never,
      update(msg({ text: undefined, document: { file_id: "d", file_name: "a.pdf", mime_type: "application/pdf" } })),
    );
    expect(client.getFile).not.toHaveBeenCalled();
    expect(prisma.db.message[0]).toMatchObject({ body: "[document] a.pdf", attach: null });
  });

  it("an image document is re-hosted", async () => {
    const { svc, prisma, media } = build({ channel: [tg("T1")] });
    await svc.ingestUpdate(
      tg("T1") as never,
      update(msg({ text: undefined, document: { file_id: "d", file_name: "x.png", mime_type: "image/png", file_size: 9 } })),
    );
    expect(media.ingestBuffer).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/png" }));
    expect(prisma.db.message[0]).toMatchObject({ body: "[document]", attach: "media-1" });
  });

  it("a failed download keeps the message with its placeholder", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const { svc, prisma, client } = build({ channel: [tg("T1")] });
    client.getFile.mockRejectedValue(new TelegramApiError(`Telegram getFile failed: /bot${TOKEN}/getFile`, 400));
    await svc.ingestUpdate(tg("T1") as never, update(msg({ text: undefined, caption: "hi", photo: [{ file_id: "big" }] })));
    expect(prisma.db.message[0]).toMatchObject({ body: "[photo]\nhi", attach: null });
    expect(warn.mock.calls.flat().join(" ")).not.toContain("AAF-very_secret");
    warn.mockRestore();
  });

  it("an oversized file is not downloaded", async () => {
    const { svc, client } = build({ channel: [tg("T1")] });
    await svc.ingestUpdate(tg("T1") as never, update(msg({ text: undefined, photo: [{ file_id: "big", file_size: 50 * 1024 * 1024 }] })));
    expect(client.getFile).not.toHaveBeenCalled();
  });

  it("other media map to placeholders", async () => {
    const { svc, prisma } = build({ channel: [tg("T1")] });
    await svc.ingestUpdate(tg("T1") as never, update(msg({ text: undefined, voice: { file_id: "v" } })));
    await svc.ingestUpdate(tg("T1") as never, update(msg({ message_id: 11, text: undefined, sticker: { file_id: "s", emoji: "😀" } }), 2));
    expect(prisma.db.message.map((m: { body: string }) => m.body)).toEqual(["[voice]", "[sticker] 😀"]);
  });

  it("a redelivered photo is not downloaded twice", async () => {
    const { svc, prisma, client } = build({ channel: [tg("T1")] });
    const u = update(msg({ text: undefined, photo: [{ file_id: "big" }] }));
    await svc.ingestUpdate(tg("T1") as never, u);
    await svc.ingestUpdate(tg("T1") as never, u);
    expect(client.getFile).toHaveBeenCalledTimes(1);
    expect(prisma.db.message).toHaveLength(1);
  });
});
