import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";

/**
 * Meta sends Facebook Page and Instagram Business webhook events to the single
 * app-level callback URL configured in the Meta dashboard. Both products share
 * one verify token + one HMAC secret (the app's secret). We dispatch on
 * `payload.object` (`page` vs `instagram`) and route each entry to the matching
 * Integration row by Page ID / IG User ID.
 */

interface PageMessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    attachments?: Array<{ type?: string; payload?: { url?: string } }>;
  };
}

interface IgMessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
  };
}

interface WebhookEntry {
  id: string; // Page ID for object=page, IG User ID for object=instagram
  time?: number;
  messaging?: Array<PageMessagingEvent | IgMessagingEvent>;
  changes?: Array<{ field?: string; value?: unknown }>;
}

interface WebhookPayload {
  object?: string;
  entry?: WebhookEntry[];
}

@Injectable()
export class MetaWebhooksService {
  private readonly log = new Logger(MetaWebhooksService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Meta's GET handshake. Mode must be "subscribe" and the verify_token must
   *  match what we'll paste into the Meta app dashboard. */
  verify(mode: string, token: string, challenge: string) {
    if (mode !== "subscribe") throw new BadRequestException("Bad mode");
    const expected = process.env.META_VERIFY_TOKEN;
    if (!expected) {
      this.log.warn("META_VERIFY_TOKEN not configured; refusing webhook verify");
      throw new BadRequestException("Verify token not configured");
    }
    if (token !== expected) throw new BadRequestException("Verify token mismatch");
    return challenge;
  }

  async handle(payload: WebhookPayload) {
    if (!payload?.object || !payload.entry) return { ok: true, skipped: true };
    let processed = 0;
    for (const entry of payload.entry) {
      if (payload.object === "page") {
        processed += await this.handlePageEntry(entry);
      } else if (payload.object === "instagram") {
        processed += await this.handleInstagramEntry(entry);
      } else {
        this.log.debug(`Unhandled webhook object=${payload.object}`);
      }
    }
    return { ok: true, processed };
  }

  // ─── Page (Facebook Messenger DMs + feed events) ───────────────────────
  private async handlePageEntry(entry: WebhookEntry): Promise<number> {
    const pageId = entry.id;
    const integ = await this.prisma.integration.findFirst({
      where: { platform: "facebook", pageId },
    });
    if (!integ) {
      this.log.warn(`Webhook for unknown FB page=${pageId}`);
      return 0;
    }
    let count = 0;
    for (const m of entry.messaging ?? []) {
      await this.ingestPageMessage(integ.workspaceId, pageId, m as PageMessagingEvent);
      count += 1;
    }
    // Feed changes (new posts, comments, reactions) — log for now so the
    // operator can see traffic; downstream upsert into Post/Comment tables
    // is a follow-up that mirrors the existing /posts and /comments
    // listing endpoints.
    for (const ch of entry.changes ?? []) {
      this.log.debug(`FB page=${pageId} change field=${ch.field}`);
      count += 1;
    }
    await this.prisma.integration.update({
      where: { id: integ.id },
      data: { lastFetchedAt: new Date() },
    });
    return count;
  }

  // ─── Instagram (DMs + comment/mention changes) ─────────────────────────
  private async handleInstagramEntry(entry: WebhookEntry): Promise<number> {
    const igUserId = entry.id;
    const integ = await this.prisma.integration.findFirst({
      where: { platform: "instagram", pageId: igUserId },
    });
    if (!integ) {
      this.log.warn(`Webhook for unknown IG user=${igUserId}`);
      return 0;
    }
    let count = 0;
    for (const m of entry.messaging ?? []) {
      await this.ingestInstagramMessage(
        integ.workspaceId,
        igUserId,
        m as IgMessagingEvent,
      );
      count += 1;
    }
    for (const ch of entry.changes ?? []) {
      this.log.debug(`IG user=${igUserId} change field=${ch.field}`);
      count += 1;
    }
    await this.prisma.integration.update({
      where: { id: integ.id },
      data: { lastFetchedAt: new Date() },
    });
    return count;
  }

  private async ingestPageMessage(
    workspaceId: string,
    pageId: string,
    evt: PageMessagingEvent,
  ) {
    const senderId = evt.sender?.id;
    if (!senderId || !evt.message?.mid) return;
    // Skip echoes of our own outbound sends (Meta replays them via webhook).
    if (evt.message.is_echo || senderId === pageId) return;

    const contact = await this.prisma.contact.upsert({
      where: {
        workspaceId_externalSource_externalId: {
          workspaceId,
          externalSource: "facebook",
          externalId: senderId,
        },
      },
      create: {
        workspaceId,
        name: "Facebook user",
        industry: "social",
        lifecycle: "lead",
        source: "facebook",
        lastSeen: "now",
        externalSource: "facebook",
        externalId: senderId,
      },
      update: { lastSeen: "now" },
    });

    const body = evt.message.text ?? "[attachment]";
    await this.appendInboundMessage({
      workspaceId,
      contactId: contact.id,
      channel: "facebook",
      body,
      timestamp: evt.timestamp,
      mid: evt.message.mid,
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: "facebook",
    });
  }

  private async ingestInstagramMessage(
    workspaceId: string,
    igUserId: string,
    evt: IgMessagingEvent,
  ) {
    const senderId = evt.sender?.id;
    if (!senderId || !evt.message?.mid) return;
    if (evt.message.is_echo || senderId === igUserId) return;

    const contact = await this.prisma.contact.upsert({
      where: {
        workspaceId_externalSource_externalId: {
          workspaceId,
          externalSource: "instagram",
          externalId: senderId,
        },
      },
      create: {
        workspaceId,
        name: `IG ${senderId.slice(-6)}`,
        industry: "instagram",
        lifecycle: "lead",
        source: "instagram",
        lastSeen: "now",
        externalSource: "instagram",
        externalId: senderId,
      },
      update: { lastSeen: "now" },
    });

    const body = evt.message.text ?? "[attachment]";
    await this.appendInboundMessage({
      workspaceId,
      contactId: contact.id,
      channel: "instagram",
      body,
      timestamp: evt.timestamp,
      mid: evt.message.mid,
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: "instagram",
    });
  }

  private async appendInboundMessage(input: {
    workspaceId: string;
    contactId: string;
    channel: string;
    body: string;
    timestamp?: number;
    mid?: string;
  }) {
    // Idempotency: Meta redelivers webhooks on any non-200/timeout, so the same
    // `mid` can arrive repeatedly. Skip if we've already stored it — otherwise
    // the unread counter double-counts and the thread shows duplicates.
    if (input.mid) {
      const seen = await this.prisma.message.findFirst({
        where: { workspaceId: input.workspaceId, metaMessageId: input.mid },
        select: { id: true },
      });
      if (seen) return;
    }

    let conv = await this.prisma.conversation.findFirst({
      where: {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        channel: input.channel,
      },
    });
    if (!conv) {
      conv = await this.prisma.conversation.create({
        data: {
          workspaceId: input.workspaceId,
          contactId: input.contactId,
          unread: 1,
          pinned: false,
          lastAt: "now",
          lastFrom: "them",
          preview: input.body.slice(0, 140),
          channel: input.channel,
          status: "human",
          intent: "—",
          confidence: 0,
        },
      });
    } else {
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: {
          preview: input.body.slice(0, 140),
          lastAt: "now",
          lastFrom: "them",
          unread: { increment: 1 },
        },
      });
    }
    const ts = input.timestamp ? new Date(input.timestamp) : new Date();
    const d = isNaN(ts.getTime()) ? new Date() : ts;
    const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    await this.prisma.message.create({
      data: {
        workspaceId: input.workspaceId,
        conversationId: conv.id,
        from: "them",
        body: input.body,
        t,
        createdAt: d,
        metaMessageId: input.mid ?? null,
      },
    });
  }
}
