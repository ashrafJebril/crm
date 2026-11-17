import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { ChannelResolver } from "../channels/channel-resolver.service";
import { ChannelTransportRegistry } from "../channels/channel-transport";
import { InboundSinkService } from "../channels/inbound-sink.service";
import { deliverViaTransport, type DeliverableConversation } from "../channels/deliver-via-transport";
import { PaymentLockService } from "../billing/payment-lock.service";
import { AgentReplyGate } from "../agent/agent-reply-gate";
import { agentImageDecision } from "../media/agent-photo";
import { LAgentService } from "./l-agent.service";
import { validateAgentAnswer } from "./agent-answer";

/** Channel kinds answered here (Zernio and Meta keep their own paths). */
export const AUTO_REPLY_KINDS = ["telegram", "webchat"] as const;

type Outcome =
  | "sent"
  | "l_disabled"
  | "no_conversation"
  | "conversation_off"
  | "locked"
  | "gated"
  | "channel_unavailable"
  | "no_answer"
  | "invalid_answer"
  | "taken_over"
  | "failed";

const CONV_SELECT = {
  id: true,
  workspaceId: true,
  aiEnabled: true,
  aiPausedAt: true,
  escalated: true,
  contactId: true,
  channel: true,
  channelId: true,
  externalId: true,
  contact: { select: { id: true, externalId: true, phone: true, name: true } },
} as const;

/**
 * SP-22 Task 2 (ruling 9): AI auto-reply on Telegram and web chat.
 *
 * `InboundSinkService` stores the inbound message first, then calls
 * `maybeQueue` (fire-and-forget, never throws). The gates, in order:
 *  - l is configured (`L_API_URL`), else no l call;
 *  - the thread is AI-enabled, not taken over (`aiPausedAt`) and not escalated;
 *  - the workspace is not payment-locked (a failed lookup fails closed);
 *  - SP-20's AgentReplyGate (emergency stop first, excluded tags, hours;
 *    fails closed). Ruling 10: a marketing opt-out does not block a reply
 *    to the customer's own message; excluded tags do;
 *  - the conversation's own channel can send (a disconnected channel is
 *    never rerouted).
 * Then l is asked once, keyed by the CRM conversation id (ruling 11); the
 * answer is validated (agent-answer.ts) and the image allowed only when it
 * is an approved photo of this workspace (SP-17). The thread and the gate are
 * re-checked at send time (a human reply during the l turn wins), and the
 * answer goes out through the channel's own transport (plain text) as one
 * `from: "ai"` Message that never pauses the AI.
 *
 * Depends on the registry, the resolver and LAgentService only (no
 * ConversationsService), and registers itself with the global inbound sink:
 * no module cycle.
 */
@Injectable()
export class AgentAutoReplyService implements OnModuleInit {
  private readonly logger = new Logger(AgentAutoReplyService.name);
  /** The last queued run (specs await it). */
  last: Promise<Outcome> = Promise.resolve("sent");

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly channels: ChannelResolver,
    private readonly transports: ChannelTransportRegistry,
    private readonly lAgent: LAgentService,
    private readonly gate: AgentReplyGate,
    @Optional() private readonly paymentLock?: PaymentLockService,
    @Optional() private readonly sink?: InboundSinkService,
  ) {}

  onModuleInit(): void {
    this.sink?.registerAutoReply((workspaceId, conversationId, text) => this.maybeQueue(workspaceId, conversationId, text));
  }

  /** Fire-and-forget: the inbound message is already stored. Never throws. */
  maybeQueue(workspaceId: string, conversationId: string, inboundText: string): void {
    this.last = this.run(workspaceId, conversationId, inboundText).catch((err) => {
      this.logger.warn(`auto-reply failed for conversation ${conversationId}: ${err instanceof Error ? err.message : String(err)}`);
      return "failed" as const;
    });
  }

  private load(workspaceId: string, conversationId: string) {
    return this.prisma.conversation.findFirst({ where: { id: conversationId, workspaceId }, select: CONV_SELECT });
  }

  private open(conv: { aiEnabled: boolean; aiPausedAt: Date | null; escalated: boolean }): boolean {
    return Boolean(conv.aiEnabled) && !conv.aiPausedAt && !conv.escalated;
  }

  async run(workspaceId: string, conversationId: string, inboundText: string): Promise<Outcome> {
    if (!this.lAgent.enabled) return "l_disabled";
    const conv = await this.load(workspaceId, conversationId);
    if (!conv || conv.workspaceId !== workspaceId) return "no_conversation";
    if (!(AUTO_REPLY_KINDS as readonly string[]).includes(conv.channel)) return "conversation_off";
    if (!this.open(conv)) return "conversation_off";
    // A failed lookup throws into maybeQueue's catch: no reply (fail closed).
    if (await this.paymentLock?.isLocked(workspaceId)) return "locked";
    // SP-20's gate: the stop first; a gate failure is no reply.
    if (!(await this.gate.allows(workspaceId, { conversationId, contactId: conv.contactId }, "l_auto_reply"))) return "gated";
    try {
      await this.channels.forSend(workspaceId, conv);
    } catch {
      return "channel_unavailable";
    }

    const result = await this.lAgent.ask(workspaceId, { externalId: conv.id, message: inboundText });
    if (!result) return "no_answer";
    const answer = validateAgentAnswer({ answer: result.answer, image_url: result.imageUrl });
    if (!answer) return "invalid_answer";

    let text = answer.text;
    if (answer.imageUrl) {
      try {
        const { decision } = await agentImageDecision(this.prisma, workspaceId, answer.imageUrl);
        // These transports send plain text: an approved photo goes as its link.
        if (decision !== "drop") text = `${text}\n\n${answer.imageUrl}`;
      } catch {
        // Fail closed on the image, never on the answer.
      }
    }

    // Re-check at send time: a human may have replied (or the stop been hit)
    // while l was thinking.
    const fresh = await this.load(workspaceId, conversationId);
    if (!fresh || !this.open(fresh)) return "taken_over";
    if (!(await this.gate.allows(workspaceId, { conversationId, contactId: fresh.contactId }, "l_auto_reply"))) return "gated";

    try {
      await deliverViaTransport(
        { prisma: this.prisma, realtime: this.realtime, channels: this.channels, transports: this.transports, logger: this.logger },
        workspaceId,
        fresh as DeliverableConversation,
        text,
        { from: "ai" },
      );
    } catch (err) {
      this.logger.warn(`auto-reply not delivered for conversation ${conversationId}: ${err instanceof Error ? err.message : String(err)}`);
      return "channel_unavailable";
    }
    return "sent";
  }
}
