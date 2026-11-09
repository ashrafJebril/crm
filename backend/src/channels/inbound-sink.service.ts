import { Injectable, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Channel } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { PipelineAutomationService } from "../tickets/pipeline-automation.service";
import { WORKFLOW_TRIGGER_EVENT, WorkflowTriggerEvent } from "../workflows/workflow-events";
import { stampLastInbound } from "./channel-resolver.service";
import { CampaignReplyAttributor } from "../campaigns/tracking/reply-attributor.service";
import { RecipientTrackerService } from "../campaigns/tracking/recipient-tracker.service";

export interface InboundRecord {
  workspaceId: string;
  channel: Channel;
  /** Contact identity namespace, e.g. "telegram", "webchat". */
  externalSource: string;
  /** The contact's id in that namespace (Telegram chat id, web visitor id). */
  externalId: string;
  contactName?: string;
  phone?: string | null;
  text: string;
  attachMediaId?: string | null;
  /** Dedupe key, stored in Message.metaMessageId (e.g. `tg:<channelId>:<id>`). */
  providerMessageId: string;
  at: Date;
}

/**
 * Shared inbound path for the new channels (Telegram, web chat). Writes the
 * contact, the channel's conversation and the message, then runs the same
 * side effects as the Zernio ingest: realtime `inbox.activity`, the pipeline
 * automation and the `message_received` workflow trigger. The Zernio and
 * Meta paths are NOT moved onto it in SP-19 (regression risk); they only got
 * the channel-aware lookup.
 *
 * AI auto-reply is not wired here (R7: deferred to SP-20/22).
 */
@Injectable()
export class InboundSinkService {
  private readonly attributor: CampaignReplyAttributor;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly pipelineAutomation: PipelineAutomationService,
    @Optional() private readonly events?: EventEmitter2,
    // SP-12, from CampaignTrackingModule; hand-built specs get one over the same Prisma.
    @Optional() attributor?: CampaignReplyAttributor,
  ) {
    this.attributor = attributor ?? new CampaignReplyAttributor(prisma, new RecipientTrackerService(prisma));
  }

  async record(input: InboundRecord): Promise<{ conversationId: string; messageId: string; duplicate: boolean }> {
    const { workspaceId, channel } = input;
    const kind = channel.kind;

    const seen = await this.prisma.message.findFirst({
      where: { workspaceId, metaMessageId: input.providerMessageId },
      select: { id: true, conversationId: true },
    });
    if (seen) return { conversationId: seen.conversationId, messageId: seen.id, duplicate: true };

    const name = input.contactName?.trim() || `${kind} user`;
    const contact = await this.prisma.contact.upsert({
      where: {
        workspaceId_externalSource_externalId: {
          workspaceId,
          externalSource: input.externalSource,
          externalId: input.externalId,
        },
      },
      create: {
        workspaceId,
        name,
        phone: input.phone ?? null,
        industry: kind,
        lifecycle: "lead",
        source: kind,
        lastSeen: "now",
        externalSource: input.externalSource,
        externalId: input.externalId,
      },
      update: { lastSeen: "now" },
    });

    const preview = (input.text || "📎").slice(0, 140);
    let conv = await this.prisma.conversation.findFirst({
      where: { workspaceId, contactId: contact.id, channelId: channel.id },
      orderBy: { updatedAt: "desc" },
    });
    if (!conv) {
      conv = await this.prisma.conversation.create({
        data: {
          workspaceId,
          contactId: contact.id,
          channelId: channel.id,
          channel: kind,
          unread: 1,
          pinned: false,
          lastAt: "now",
          lastFrom: "them",
          preview,
          status: "human",
          intent: "—",
          confidence: 0,
        },
      });
    } else {
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { preview, lastAt: "now", lastFrom: "them", unread: { increment: 1 } },
      });
    }

    const at = input.at;
    const t = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const message = await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId: conv.id,
        from: "them",
        body: input.text,
        t,
        attach: input.attachMediaId ?? null,
        metaMessageId: input.providerMessageId,
        createdAt: at,
      },
    });
    await stampLastInbound(this.prisma, channel.id);

    // SP-12: no campaign sends on these channels today, but the reply rule
    // lives in one place. Never throws.
    await this.attributor.onInbound({
      workspaceId,
      channelId: channel.id,
      contactId: contact.id,
      phone: input.phone ?? contact.phone,
      text: input.text,
      inboundMessageId: message.id,
      at,
    });

    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: kind,
      channelId: channel.id,
      conversationId: conv.id,
    });
    await this.pipelineAutomation.onInboundMessage(workspaceId, contact.id, conv.id, kind, input.text || undefined);
    this.events?.emit(WORKFLOW_TRIGGER_EVENT, {
      workspaceId,
      triggerType: "message_received",
      payload: {
        contact: { id: contact.id, name: contact.name },
        conversation: { id: conv.id, channel: kind },
        message: { body: input.text },
      },
    } satisfies WorkflowTriggerEvent);

    return { conversationId: conv.id, messageId: message.id, duplicate: false };
  }
}
