import { Injectable, OnModuleInit } from "@nestjs/common";
import type { Channel, Message } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { RealtimeService } from "../../realtime/realtime.service";
import { channelError } from "../channel-errors";
import { ChannelTransportRegistry, type TransportConversation } from "../channel-transport";
import { InboundSinkService } from "../inbound-sink.service";
import { renderChatPage, type WidgetLang } from "./hosted-page";
import { COLOR_RE, MAX_GREETING, originOptions } from "./origin-match";
import { isVisitorId, mintVisitor, verifyVisitorToken } from "./visitor-token";

export const MAX_WIDGET_MESSAGE = 2000;
export const MAX_VISITOR_NAME = 80;
export const DEFAULT_VISITOR_NAME = { en: "Website visitor", ar: "زائر الموقع" } as const;
/** The live event a visitor's sockets receive. */
export const WIDGET_MESSAGE_EVENT = "widget.message";
const HISTORY_LIMIT = 200;

/** The only channel fields a public widget response carries. */
export interface WidgetPublicConfig {
  displayName: string;
  greeting: string | null;
  greetingAr: string | null;
  color: string | null;
  position: "start" | "end";
  askName: boolean;
  lang: WidgetLang | null;
}

/** A message as a visitor sees it (no workspace, contact or conversation ids). */
export interface WidgetMessage {
  id: string;
  from: "visitor" | "agent";
  body: string;
  at: string;
}

export interface PostWidgetMessageInput {
  body?: unknown;
  name?: unknown;
  visitorId?: unknown;
  visitorToken?: unknown;
}

const obj = (c: unknown): Record<string, unknown> =>
  c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : {};

const asLang = (v: unknown): WidgetLang | null => (v === "en" || v === "ar" ? v : null);

/** The first en/ar tag of an Accept-Language header. */
export function langFromAcceptLanguage(h: unknown): WidgetLang | null {
  if (typeof h !== "string") return null;
  for (const part of h.split(",").slice(0, 10)) {
    const tag = part.split(";")[0].trim().toLowerCase();
    if (tag.startsWith("ar")) return "ar";
    if (tag.startsWith("en")) return "en";
  }
  return null;
}

export function toWidgetMessage(m: Pick<Message, "id" | "from" | "body" | "createdAt">): WidgetMessage {
  return {
    id: m.id,
    from: m.from === "them" ? "visitor" : "agent",
    body: m.body,
    at: (m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt)).toISOString(),
  };
}

/**
 * SP-19 T3 — the website chat widget.
 *  - public config, visitor messages and history for the widget API;
 *  - the hosted chat page;
 *  - the `native` ChannelTransport: agent replies through
 *    `POST /conversations/:id/send`. `sendText` writes nothing (the route
 *    writes the Message row, `from "human"`); `delivered` emits
 *    `widget.message` to the visitor's room `widget:<channelId>:<visitorId>`.
 * Visitor contacts and conversations are written by InboundSinkService in
 * the channel's own workspace (`externalSource "webchat"`, `externalId =
 * visitorId`). No AI auto-reply (R7).
 */
@Injectable()
export class WebchatService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sink: InboundSinkService,
    private readonly transports: ChannelTransportRegistry,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    if (this.transports.get("native")) return;
    this.transports.register({
      provider: "native",
      sendText: (channel, conv) => this.sendText(channel, conv),
      delivered: (channel, conv, message) => this.delivered(channel, conv, message),
    });
  }

  // ── Public widget API ────────────────────────────────────────────────────

  publicConfig(channel: Channel): WidgetPublicConfig {
    const c = obj(channel.config);
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_GREETING) : null);
    return {
      displayName: channel.displayName,
      greeting: str(c.greeting),
      greetingAr: str(c.greetingAr),
      color: typeof c.color === "string" && COLOR_RE.test(c.color) ? c.color : null,
      position: c.position === "start" ? "start" : "end",
      askName: c.askName === true,
      lang: asLang(c.lang),
    };
  }

  /** `?lang=`, then the channel's `config.lang`, then the browser's
   *  Accept-Language, then the workspace language, else English. */
  async resolveLang(channel: Channel, requested?: unknown, acceptLanguage?: unknown): Promise<WidgetLang> {
    const direct = asLang(requested) ?? asLang(obj(channel.config).lang) ?? langFromAcceptLanguage(acceptLanguage);
    if (direct) return direct;
    const ws = await this.prisma.raw.workspace.findUnique({ where: { id: channel.workspaceId }, select: { lang: true } });
    return asLang(ws?.lang) ?? "en";
  }

  async postMessage(
    channel: Channel,
    input: PostWidgetMessageInput,
  ): Promise<{ visitorId: string; visitorToken: string; message: WidgetMessage }> {
    const text = typeof input.body === "string" ? input.body.trim() : "";
    if (!text || text.length > MAX_WIDGET_MESSAGE) throw channelError("widget.invalid_message", { field: "body" });
    let name: string | undefined;
    if (input.name !== undefined && input.name !== null) {
      if (typeof input.name !== "string" || input.name.trim().length > MAX_VISITOR_NAME) {
        throw channelError("widget.invalid_message", { field: "name" });
      }
      name = input.name.trim() || undefined;
    }

    let visitorId: string;
    let visitorToken: string;
    if (input.visitorId !== undefined && input.visitorId !== null && input.visitorId !== "") {
      if (!verifyVisitorToken(channel.id, input.visitorId, input.visitorToken)) throw channelError("widget.visitor_forbidden");
      visitorId = input.visitorId as string;
      visitorToken = input.visitorToken as string;
    } else {
      ({ visitorId, visitorToken } = mintVisitor(channel.id));
    }

    const lang = await this.resolveLang(channel);
    const at = new Date();
    const out = await this.sink.record({
      workspaceId: channel.workspaceId,
      channel,
      externalSource: "webchat",
      externalId: visitorId,
      contactName: name ?? DEFAULT_VISITOR_NAME[lang],
      text,
      providerMessageId: `wc:${channel.id}:${randomUUID()}`,
      at,
    });
    const message: WidgetMessage = { id: out.messageId, from: "visitor", body: text, at: at.toISOString() };
    // Other tabs of the same visitor see it live too (clients de-duplicate by id).
    this.realtime.emitToWidgetVisitor(channel.id, visitorId, WIDGET_MESSAGE_EVENT, message);
    return { visitorId, visitorToken, message };
  }

  /** The visitor's own conversation on this channel, nothing else. */
  async listMessages(
    channel: Channel,
    q: { visitorId?: unknown; visitorToken?: unknown; after?: unknown },
  ): Promise<{ items: WidgetMessage[] }> {
    if (!verifyVisitorToken(channel.id, q.visitorId, q.visitorToken)) throw channelError("widget.visitor_forbidden");
    const visitorId = q.visitorId as string;
    const contact = await this.prisma.raw.contact.findFirst({
      where: { workspaceId: channel.workspaceId, externalSource: "webchat", externalId: visitorId },
      select: { id: true },
    });
    if (!contact) return { items: [] };
    const conv = await this.prisma.raw.conversation.findFirst({
      where: { workspaceId: channel.workspaceId, contactId: contact.id, channelId: channel.id },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (!conv) return { items: [] };

    const after = typeof q.after === "string" && q.after ? new Date(q.after) : null;
    const where = {
      workspaceId: channel.workspaceId,
      conversationId: conv.id,
      from: { in: ["them", "human", "ai"] },
      ...(after && !Number.isNaN(after.getTime()) ? { createdAt: { gt: after } } : {}),
    };
    const rows = after
      ? await this.prisma.raw.message.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: HISTORY_LIMIT })
      : (await this.prisma.raw.message.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: HISTORY_LIMIT })).reverse();
    return { items: rows.map(toWidgetMessage) };
  }

  async renderPage(
    channel: Channel,
    opts: { embed: boolean; lang?: unknown; acceptLanguage?: unknown; apiOrigin: string; parent: string | null },
  ): Promise<{ html: string; csp: string }> {
    const lang = await this.resolveLang(channel, opts.lang, opts.acceptLanguage);
    return renderChatPage({
      channel: { id: channel.id, displayName: channel.displayName, config: channel.config },
      lang,
      embed: opts.embed,
      nonce: randomBytes(16).toString("base64"),
      apiOrigin: opts.apiOrigin,
      parent: opts.parent,
      originOpts: originOptions(),
    });
  }

  // ── Transport (provider "native") ────────────────────────────────────────

  private visitorOf(channel: Channel, conv: TransportConversation): string {
    if (channel.kind !== "webchat") throw channelError("channels.transport_unavailable", { provider: channel.provider });
    const id = conv.contact?.externalId ?? null;
    if (!isVisitorId(id)) throw channelError("channels.not_connected");
    return id;
  }

  /** Nothing to call: the visitor reads from our own API. The route writes
   *  the Message row after this returns. */
  private async sendText(channel: Channel, conv: TransportConversation): Promise<{ providerMessageId: string }> {
    this.visitorOf(channel, conv);
    return { providerMessageId: `wc:${channel.id}:${randomUUID()}` };
  }

  private delivered(channel: Channel, conv: TransportConversation, message: Message): void {
    const visitorId = this.visitorOf(channel, conv);
    this.realtime.emitToWidgetVisitor(channel.id, visitorId, WIDGET_MESSAGE_EVENT, toWidgetMessage(message));
  }
}
