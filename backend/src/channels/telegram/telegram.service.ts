import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma, type Channel } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { RealtimeService } from "../../realtime/realtime.service";
import { MediaService } from "../../media/media.service";
import { channelError } from "../channel-errors";
import { toChannelDto, type ChannelDto } from "../channel-dto";
import { ChannelTransportRegistry, type TransportConversation } from "../channel-transport";
import { credentialsFor, encryptChannelSecrets } from "../channel-credentials";
import { InboundSinkService } from "../inbound-sink.service";
import { ensureDefaultPerKind, isUniqueViolation } from "../legacy-mirror";
import { BOT_TOKEN_RE, scrubToken, TelegramClient, type TelegramBot } from "./telegram.client";

/** statusReason values this flow writes. */
export const TELEGRAM_WEBHOOK_FAILED = "telegram_webhook_failed";
export const TELEGRAM_SAVE_FAILED = "telegram_save_failed";

/** Bot API getFile only serves files up to 20 MB. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** A bot in these states belongs to its workspace; another connect is a 409. */
const LIVE = ["active", "needs_attention"];

export interface ConnectTelegramInput {
  botToken: string;
  displayName?: string;
}

/* Minimal Bot API update shapes (only what we read). */
interface TgUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
interface TgFileRef { file_id: string; file_size?: number; file_name?: string; mime_type?: string }
interface TgMessage {
  message_id: number;
  date?: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgFileRef[];
  document?: TgFileRef;
  sticker?: { file_id: string; emoji?: string };
  [k: string]: unknown;
}

/** Media kinds without a download: shown as a `[kind]` placeholder. */
const PLACEHOLDER_KINDS = ["voice", "audio", "video", "video_note", "animation", "location", "contact", "poll"] as const;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * SP-19 T2 — Telegram bot channels.
 *  - `provision`: Tkana's provisionTelegramChannel order (public URL, getMe,
 *    row, setWebhook with a fresh secret, active). Errors after the row
 *    exists park it in `error` so `POST /channels/:id/reconnect` can retry.
 *  - `ingestUpdate`: private-chat messages → InboundSinkService.
 *  - the `telegram` ChannelTransport: sendText (sendMessage), disconnect
 *    (deleteWebhook, best effort) and reconnect (rotate secret, setWebhook).
 * The bot token lives only in `secretsEnc`; it is never logged, returned or
 * put in an error (every Telegram error is masked by the client).
 */
@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly log = new Logger(TelegramService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TelegramClient,
    private readonly sink: InboundSinkService,
    private readonly transports: ChannelTransportRegistry,
    private readonly realtime: RealtimeService,
    @Optional() private readonly media?: MediaService,
  ) {}

  onModuleInit(): void {
    if (this.transports.get("telegram")) return;
    this.transports.register({
      provider: "telegram",
      sendText: (channel, conv, body) => this.sendText(channel, conv, body),
      disconnect: (channel) => this.teardown(channel),
      reconnect: (channel) => this.reconnect(channel),
    });
  }

  // ── Connect ──────────────────────────────────────────────────────────────

  async provision(workspaceId: string, input: ConnectTelegramInput): Promise<ChannelDto> {
    const base = this.publicBase();
    const token = (input.botToken ?? "").trim();
    if (!BOT_TOKEN_RE.test(token)) throw channelError("channels.telegram_invalid_token");
    // R5: refuse before anything is created when secrets cannot be encrypted.
    const secretsEnc = encryptChannelSecrets({ botToken: token });
    const bot = await this.verifyToken(token);
    const externalId = String(bot.id);

    const existing = await this.prisma.raw.channel.findMany({
      where: { provider: "telegram", externalId },
      orderBy: { updatedAt: "desc" },
    });
    const mine = existing.find((r) => r.workspaceId === workspaceId);
    if (mine && LIVE.includes(mine.status)) throw channelError("channels.already_connected");
    if (existing.some((r) => r.workspaceId !== workspaceId && LIVE.includes(r.status))) {
      throw channelError("channels.connected_elsewhere");
    }

    const displayName = (input.displayName ?? "").trim() || bot.first_name?.trim() || `@${bot.username ?? externalId}`;
    const base_ = {
      displayName,
      status: "pending",
      statusReason: null,
      disconnectedAt: null,
      secretsEnc,
      webhookSecretHash: null,
    };
    let row: Channel;
    if (mine) {
      // Same bot again (soft-disconnected, errored or stuck pending): the row
      // and its history are reused (R9).
      const config = { ...this.objectConfig(mine.config), botUsername: bot.username ?? null };
      row = await this.prisma.channel.update({
        where: { id: mine.id },
        data: { ...base_, config: config as Prisma.InputJsonValue },
      });
    } else {
      try {
        row = await this.prisma.channel.create({
          data: {
            workspaceId,
            kind: "telegram",
            provider: "telegram",
            externalId,
            isDefault: false,
            config: { botUsername: bot.username ?? null } as Prisma.InputJsonValue,
            ...base_,
          },
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw channelError("channels.already_connected"); // a concurrent connect won
        throw e;
      }
    }

    const done = await this.registerWebhook(row, token, base);
    await ensureDefaultPerKind(this.prisma, workspaceId);
    this.realtime.emitToWorkspace(workspaceId, "channels.updated", { channelId: row.id });
    const fresh = await this.prisma.channel.findFirst({ where: { id: row.id, workspaceId } });
    return toChannelDto(fresh ?? done);
  }

  /** Transport hook behind `POST /channels/:id/reconnect`. */
  async reconnect(channel: Channel): Promise<Channel> {
    const base = this.publicBase();
    const { botToken } = await credentialsFor(this.prisma, channel);
    if (!botToken || !BOT_TOKEN_RE.test(botToken)) throw channelError("channels.telegram_invalid_token");
    const bot = await this.verifyToken(botToken);
    if (String(bot.id) !== channel.externalId) throw channelError("channels.telegram_invalid_token");
    const elsewhere = await this.prisma.raw.channel.findFirst({
      where: {
        provider: "telegram",
        externalId: channel.externalId,
        workspaceId: { not: channel.workspaceId },
        status: { in: LIVE },
      },
      select: { id: true },
    });
    if (elsewhere) throw channelError("channels.connected_elsewhere");
    if (bot.username) {
      const config = { ...this.objectConfig(channel.config), botUsername: bot.username };
      channel = await this.prisma.channel.update({
        where: { id: channel.id },
        data: { config: config as Prisma.InputJsonValue },
      });
    }
    return this.registerWebhook(channel, botToken, base);
  }

  /**
   * Rotate the secret and point the bot's webhook here. The hash is stored
   * BEFORE setWebhook so the first update signed with the new secret already
   * validates. A failure parks the row in `error` (retry via reconnect).
   */
  private async registerWebhook(row: Channel, token: string, base: string): Promise<Channel> {
    const secret = randomBytes(32).toString("hex");
    try {
      await this.prisma.channel.update({ where: { id: row.id }, data: { webhookSecretHash: sha256(secret) } });
    } catch (e) {
      return this.park(row, TELEGRAM_SAVE_FAILED, e);
    }
    try {
      await this.client.setWebhook(token, { url: this.webhookUrl(base, row.id), secretToken: secret });
    } catch (e) {
      return this.park(row, TELEGRAM_WEBHOOK_FAILED, e);
    }
    try {
      return await this.prisma.channel.update({
        where: { id: row.id },
        data: { status: "active", statusReason: null, disconnectedAt: null },
      });
    } catch (e) {
      return this.park(row, TELEGRAM_SAVE_FAILED, e);
    }
  }

  private async park(row: Channel, reason: string, e: unknown): Promise<Channel> {
    this.log.warn(`telegram channel ${row.id}: ${reason}: ${scrubToken(String((e as Error)?.message ?? e))}`);
    try {
      return await this.prisma.channel.update({
        where: { id: row.id },
        data: { status: "error", statusReason: reason, isDefault: false },
      });
    } catch {
      return { ...row, status: "error", statusReason: reason };
    }
  }

  private async verifyToken(token: string): Promise<TelegramBot> {
    try {
      const bot = await this.client.getMe(token);
      if (!bot || typeof bot.id !== "number" || bot.is_bot === false) throw new Error("not a bot");
      return bot;
    } catch (e) {
      this.log.warn(`telegram getMe rejected the token: ${scrubToken(String((e as Error)?.message ?? e), token)}`);
      throw channelError("channels.telegram_invalid_token");
    }
  }

  /** PUBLIC_BASE_URL (the API's public origin, without /api) must be https:
   *  Telegram only delivers webhooks to https URLs. */
  private publicBase(): string {
    const raw = (process.env.PUBLIC_BASE_URL ?? "").trim();
    let ok = false;
    try {
      ok = new URL(raw).protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) throw channelError("channels.telegram_needs_public_url");
    return raw.replace(/\/+$/, "");
  }

  webhookUrl(base: string, channelId: string): string {
    return `${base}/api/webhooks/telegram/${encodeURIComponent(channelId)}`;
  }

  private objectConfig(config: unknown): Record<string, unknown> {
    return config && typeof config === "object" && !Array.isArray(config) ? { ...(config as Record<string, unknown>) } : {};
  }

  // ── Transport ────────────────────────────────────────────────────────────

  private async sendText(channel: Channel, conv: TransportConversation, body: string) {
    const chatId = conv.contact?.externalId ?? null;
    if (!chatId) throw channelError("channels.telegram_send_failed", { reason: "no_chat" });
    const { botToken } = await credentialsFor(this.prisma, channel);
    if (!botToken) throw channelError("channels.not_connected");
    try {
      const sent = await this.client.sendMessage(botToken, chatId, body);
      return { providerMessageId: `tg:${channel.id}:${chatId}:${sent.message_id}` };
    } catch (e) {
      const reason = scrubToken(String((e as Error)?.message ?? e), botToken);
      this.log.warn(`telegram send on channel ${channel.id} failed: ${reason}`);
      throw channelError("channels.telegram_send_failed", { reason });
    }
  }

  /** Best-effort deleteWebhook on a soft disconnect. Never throws. */
  private async teardown(channel: Channel): Promise<void> {
    try {
      const { botToken } = await credentialsFor(this.prisma, channel);
      if (botToken) await this.client.deleteWebhook(botToken);
    } catch (e) {
      this.log.warn(`telegram deleteWebhook for channel ${channel.id} failed: ${scrubToken(String((e as Error)?.message ?? e))}`);
    }
  }

  // ── Inbound ──────────────────────────────────────────────────────────────

  /**
   * One webhook update (already secret-validated). Private chats only;
   * groups, channels, bots and non-message updates are ignored. Dedupe key:
   * `tg:<channelId>:<chatId>:<message_id>` (message ids are per chat).
   */
  async ingestUpdate(channel: Channel, update: unknown): Promise<void> {
    const message = (update as { message?: TgMessage } | null)?.message;
    if (!message || typeof message !== "object") return;
    if (message.chat?.type !== "private" || typeof message.chat.id !== "number") return;
    if (!message.from || message.from.is_bot) return;
    if (typeof message.message_id !== "number") return;

    const chatId = String(message.chat.id);
    const providerMessageId = `tg:${channel.id}:${chatId}:${message.message_id}`;
    const seen = await this.prisma.message.findFirst({
      where: { workspaceId: channel.workspaceId, metaMessageId: providerMessageId },
      select: { id: true },
    });
    if (seen) return; // redelivery: no second download

    const { text, attachMediaId } = await this.content(channel, message);
    if (!text && !attachMediaId) return;

    const from = message.from;
    const full = [from.first_name, from.last_name].filter((s) => s && s.trim()).join(" ").trim();
    const contactName = full || (from.username ? `@${from.username}` : undefined);
    await this.sink.record({
      workspaceId: channel.workspaceId,
      channel,
      externalSource: "telegram",
      externalId: chatId,
      contactName,
      text,
      attachMediaId,
      providerMessageId,
      at: typeof message.date === "number" ? new Date(message.date * 1000) : new Date(),
    });
  }

  private async content(channel: Channel, m: TgMessage): Promise<{ text: string; attachMediaId: string | null }> {
    if (typeof m.text === "string" && m.text) return { text: m.text, attachMediaId: null };
    const caption = typeof m.caption === "string" ? m.caption : "";
    const withCaption = (placeholder: string) => (caption ? `${placeholder}\n${caption}` : placeholder);

    if (Array.isArray(m.photo) && m.photo.length) {
      const largest = m.photo[m.photo.length - 1];
      const id = await this.rehost(channel, largest, "image/jpeg", `telegram-${m.message_id}.jpg`);
      return id ? { text: caption || "[photo]", attachMediaId: id } : { text: withCaption("[photo]"), attachMediaId: null };
    }
    if (m.document && typeof m.document === "object") {
      const doc = m.document;
      const mime = typeof doc.mime_type === "string" ? doc.mime_type : "";
      const id = mime.startsWith("image/")
        ? await this.rehost(channel, doc, mime, doc.file_name || `telegram-${m.message_id}`)
        : null;
      if (id) return { text: caption || "[document]", attachMediaId: id };
      const label = doc.file_name ? `[document] ${doc.file_name}` : "[document]";
      return { text: withCaption(label), attachMediaId: null };
    }
    if (m.sticker && typeof m.sticker === "object") {
      return { text: m.sticker.emoji ? `[sticker] ${m.sticker.emoji}` : "[sticker]", attachMediaId: null };
    }
    for (const kind of PLACEHOLDER_KINDS) {
      if (m[kind]) return { text: withCaption(`[${kind}]`), attachMediaId: null };
    }
    return { text: caption, attachMediaId: null };
  }

  /** Download a Telegram file and store it through MediaService. Any failure
   *  is logged (masked) and leaves the message with its placeholder. */
  private async rehost(channel: Channel, ref: TgFileRef, mimeType: string, fileName: string): Promise<string | null> {
    if (!this.media || !ref?.file_id) return null;
    if (typeof ref.file_size === "number" && ref.file_size > MAX_DOWNLOAD_BYTES) return null;
    let token: string | undefined;
    try {
      token = (await credentialsFor(this.prisma, channel)).botToken;
      if (!token) return null;
      const file = await this.client.getFile(token, ref.file_id);
      if (!file.file_path || (typeof file.file_size === "number" && file.file_size > MAX_DOWNLOAD_BYTES)) return null;
      const buffer = await this.client.downloadFile(token, file.file_path);
      const media = await this.media.ingestBuffer({ workspaceId: channel.workspaceId, buffer, mimeType, fileName });
      return media.id;
    } catch (e) {
      this.log.warn(`telegram media for channel ${channel.id} not stored: ${scrubToken(String((e as Error)?.message ?? e), token)}`);
      return null;
    }
  }
}
