import { ForbiddenException, Injectable, Logger, Optional } from "@nestjs/common";
import { UsageService } from "../billing/usage.service";
import * as crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { AgentReplyGate } from "../agent/agent-reply-gate";
import { L_MESSAGE_RECEIVED, type LMessageWebhookDto, type LShouldReplyDto } from "./l-webhooks.dto";

@Injectable()
export class LWebhooksService {
  private readonly logger = new Logger(LWebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: AgentReplyGate,
    private readonly realtime: RealtimeService,
    @Optional() private readonly usage?: UsageService,
  ) {}

  /** The CRM workspace linked to an l workspace, or null. */
  private async workspaceFor(lWorkspaceId: string): Promise<{ id: string } | null> {
    // Raw SQL: Prisma types may not carry lWorkspaceId until regenerated.
    const result = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Workspace" WHERE "lWorkspaceId" = ${lWorkspaceId}
    `;
    return result[0] ?? null;
  }

  /**
   * Whether the agent may answer this turn of a chat that started on l: the
   * same gate every other automatic reply asks (stop, the conversation's AI
   * switch, excluded tags, working hours).
   *
   * A workspace that is not linked here is not ours to gate: yes. A failure
   * to decide fails closed, as for every other path (the gate logs it); l
   * itself fails open only when it cannot reach us at all.
   */
  async shouldReply(body: LShouldReplyDto): Promise<{ reply: boolean }> {
    const workspace = await this.workspaceFor(body.workspaceId);
    if (!workspace) return { reply: true };

    const conv = await this.prisma.$queryRaw<{ id: string; contactId: string }[]>`
      SELECT id, "contactId" FROM "Conversation"
      WHERE "lConversationId" = ${body.conversationId}
      AND "workspaceId" = ${workspace.id}
      LIMIT 1
    `;
    // The first turn of a chat has no conversation here yet; the contact may
    // already exist from an earlier chat, and its tags still count.
    const contactId =
      conv[0]?.contactId ??
      (
        await this.prisma.contact.findUnique({
          where: {
            workspaceId_externalSource_externalId: { workspaceId: workspace.id, externalSource: "l", externalId: body.userId },
          },
          select: { id: true },
        })
      )?.id ??
      null;

    const reply = await this.gate.allows(workspace.id, { conversationId: conv[0]?.id ?? null, contactId }, "l_origin");
    return { reply };
  }

  verifySecret(provided: string | undefined): void {
    const expected = process.env.L_WEBHOOK_SECRET;
    if (!expected) {
      throw new ForbiddenException(
        "Webhook receiver not configured (L_WEBHOOK_SECRET unset)",
      );
    }
    const a = Buffer.from(provided ?? "");
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new ForbiddenException("Invalid webhook secret");
    }
  }

  async handle(body: LMessageWebhookDto): Promise<{ ok: true }> {
    const { data } = body;
    // A customer message our gate held for a person, rather than an answer.
    const fromCustomer = body.event === L_MESSAGE_RECEIVED;

    const workspace = await this.workspaceFor(data.workspaceId);

    if (!workspace) {
      this.logger.warn(
        `No CRM workspace mapping found for l workspace ${data.workspaceId}`,
      );
      return { ok: true }; // Return ok to not retry
    }

    // Look up or create contact for this l user
    const contact = await this.prisma.contact.upsert({
      where: {
        workspaceId_externalSource_externalId: {
          workspaceId: workspace.id,
          externalSource: "l",
          externalId: data.userId,
        },
      },
      update: { lastSeen: "now" },
      create: {
        workspaceId: workspace.id,
        externalSource: "l",
        externalId: data.userId,
        name: `Agent Platform User ${data.userId.slice(0, 8)}`,
        industry: "—",
        lifecycle: "customer",
        source: "l",
        lastSeen: "now",
      },
      select: { id: true },
    });

    // Look up or create conversation by l conversation id
    // Use raw SQL until Prisma types are regenerated
    const convResult = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Conversation"
      WHERE "lConversationId" = ${data.conversationId}
      AND "workspaceId" = ${workspace.id}
      LIMIT 1
    `;
    const existingConversation = convResult[0];

    let conversation: { id: string };
    if (existingConversation) {
      await this.prisma.conversation.update({
        where: { id: existingConversation.id },
        data: {
          lastAt: data.timestamp,
          preview: data.message,
          // A held customer message waits for a person: count it as unread.
          ...(fromCustomer ? { lastFrom: "them", unread: { increment: 1 } } : {}),
        },
      });
      conversation = existingConversation;
    } else {
      conversation = await this.prisma.conversation.create({
        data: {
          contactId: contact.id,
          workspaceId: workspace.id,
          channel: "l",
          lastAt: data.timestamp,
          lastFrom: fromCustomer ? "them" : "ai",
          ...(fromCustomer ? { unread: 1 } : {}),
          preview: data.message,
          status: "human",
          intent: "",
          confidence: 0,
        },
        select: { id: true },
      });
      // Update with l-specific fields via raw SQL
      await this.prisma.$executeRaw`
        UPDATE "Conversation"
        SET "lConversationId" = ${data.conversationId}, "lAgentId" = ${data.agentId}
        WHERE id = ${conversation.id}
      `;
    }

    // Create message record
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        t: new Date(data.timestamp).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        body: data.message,
        ...(fromCustomer ? { from: "them" } : { from: "ai", agent: data.agentId }),
        attach: data.imageUrl ?? null,
      },
    });

    if (fromCustomer) {
      // Someone has to answer it, and the inbox is already open: tell it.
      this.realtime.emitToWorkspace(workspace.id, "inbox.activity", {
        channel: "l",
        conversationId: conversation.id,
      });
      return { ok: true };
    }

    // SP-28: meter the AI reply (once per message; never fails the webhook).
    await this.usage?.record(workspace.id, { meter: "ai_reply", sourceKind: "message", sourceId: msg.id });

    this.logger.debug(
      `l message from agent ${data.agentId} → conversation ${data.conversationId} in workspace ${workspace.id}`,
    );
    return { ok: true };
  }
}
