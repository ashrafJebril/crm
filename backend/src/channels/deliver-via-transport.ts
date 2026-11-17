import type { Logger } from "@nestjs/common";
import type { Channel, Message } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { RealtimeService } from "../realtime/realtime.service";
import type { ChannelResolver } from "./channel-resolver.service";
import { ChannelTransportRegistry, type TransportConversation } from "./channel-transport";
import { channelError } from "./channel-errors";

export interface TransportDeliveryDeps {
  prisma: PrismaService;
  realtime: RealtimeService;
  channels: ChannelResolver;
  transports: ChannelTransportRegistry;
  logger: Pick<Logger, "warn">;
}

/** The conversation as loaded with its contact. */
export interface DeliverableConversation {
  id: string;
  channel: string;
  channelId: string | null;
  externalId: string | null;
  contactId: string;
  contact: { id: string; externalId: string | null; phone: string | null; name: string } | null;
}

/**
 * SP-22: the transport write shared by `POST /conversations/:id/send` (a
 * staff reply, `from: "human"`) and the Telegram/web-chat AI auto-reply
 * (`from: "ai"`), extracted from ConversationsService.sendViaChannel. Order
 * (the ChannelTransport contract): resolve the conversation's own channel
 * (a disconnected channel throws, never another channel), `sendText`, then
 * one Message row, the conversation preview, realtime `inbox.activity`, and
 * the transport's `delivered` hook (web chat: `widget.message`).
 *
 * A human reply takes an AI thread over (`aiPausedAt = now`); the AI's own
 * reply never pauses the AI and leaves the unread count alone.
 */
export async function deliverViaTransport(
  deps: TransportDeliveryDeps,
  workspaceId: string,
  conv: DeliverableConversation,
  text: string,
  opts: { from: "human" | "ai"; extra?: Record<string, unknown> },
): Promise<{ message: Message; channel: Channel }> {
  const channel = await deps.channels.forSend(workspaceId, conv);
  const transport = deps.transports.get(channel.provider);
  if (!transport) throw channelError("channels.transport_unavailable", { provider: channel.provider });

  const target: TransportConversation = {
    id: conv.id,
    workspaceId,
    channel: conv.channel,
    channelId: channel.id,
    externalId: conv.externalId,
    contactId: conv.contactId,
    contact: conv.contact ?? null,
  };
  const { providerMessageId } = await transport.sendText(channel, target, text);

  const now = new Date();
  const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const message = await deps.prisma.message.create({
    data: {
      workspaceId,
      conversationId: conv.id,
      from: opts.from,
      body: text,
      t,
      metaMessageId: providerMessageId,
      deliveryStatus: providerMessageId ? "sent" : null,
      deliveryStatusAt: providerMessageId ? now : null,
      ...(opts.extra ?? {}),
    },
  });
  await deps.prisma.conversation.update({
    where: { id: conv.id },
    data:
      opts.from === "human"
        ? // A human reply takes an AI-handled thread over, as in addMessage.
          { preview: text.slice(0, 140), lastAt: "now", lastFrom: "human", unread: 0, aiPausedAt: now }
        : { preview: text.slice(0, 140), lastAt: "now", lastFrom: "ai" },
  });
  deps.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
    channel: conv.channel,
    channelId: channel.id,
    conversationId: conv.id,
  });
  if (transport.delivered) {
    try {
      await transport.delivered(channel, target, message);
    } catch (e) {
      deps.logger.warn(`post-delivery hook failed for ${channel.provider}: ${(e as Error).message}`);
    }
  }
  return { message, channel };
}
