import { Injectable } from "@nestjs/common";
import type { Channel, Message } from "@prisma/client";

/** The conversation a transport delivers into (with its contact). */
export interface TransportConversation {
  id: string;
  workspaceId: string;
  channel: string;
  channelId: string | null;
  externalId: string | null;
  contactId: string;
  contact: { id: string; externalId: string | null; phone: string | null; name: string } | null;
}

/**
 * Outbound delivery for channels without a dedicated send route.
 * Registered per provider: T2 adds "telegram", T3 adds "native" (web chat).
 * Zernio and Meta keep their existing send routes. SP-13 reuses this for
 * per-number splits.
 *
 * Contract for `POST /conversations/:id/send`:
 *  1. `sendText` delivers and returns the provider's message id (stored in
 *     `Message.metaMessageId`, e.g. `tg:<channelId>:<message_id>`). It must
 *     NOT write the Message row — the route does, once, after success.
 *  2. `delivered` (optional) runs after the row is written, with the row,
 *     e.g. to emit `widget.message` with the real message id.
 *  3. `disconnect` (optional) is the provider-side teardown on a soft
 *     disconnect (`DELETE /channels/:id`), best effort.
 */
export interface ChannelTransport {
  readonly provider: string;
  sendText(
    channel: Channel,
    conv: TransportConversation,
    body: string,
  ): Promise<{ providerMessageId: string | null }>;
  delivered?(channel: Channel, conv: TransportConversation, message: Message): Promise<void> | void;
  disconnect?(channel: Channel): Promise<void>;
}

@Injectable()
export class ChannelTransportRegistry {
  private readonly byProvider = new Map<string, ChannelTransport>();

  register(t: ChannelTransport): void {
    if (this.byProvider.has(t.provider)) {
      throw new Error(`ChannelTransport for "${t.provider}" is already registered`);
    }
    this.byProvider.set(t.provider, t);
  }

  get(provider: string): ChannelTransport | undefined {
    return this.byProvider.get(provider);
  }

  providers(): string[] {
    return [...this.byProvider.keys()];
  }
}
