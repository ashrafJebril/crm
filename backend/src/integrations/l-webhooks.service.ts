import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import type { LMessageWebhookDto } from "./l-webhooks.dto";

@Injectable()
export class LWebhooksService {
  private readonly logger = new Logger(LWebhooksService.name);

  constructor(private readonly prisma: PrismaService) {}

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

    // Resolve l workspace ID → crm workspace ID via raw SQL query
    // (Prisma types won't have lWorkspaceId until client is regenerated)
    const result = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Workspace" WHERE "lWorkspaceId" = ${data.workspaceId}
    `;
    const workspace = result[0];

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
        data: { lastAt: data.timestamp, preview: data.message },
      });
      conversation = existingConversation;
    } else {
      conversation = await this.prisma.conversation.create({
        data: {
          contactId: contact.id,
          workspaceId: workspace.id,
          channel: "l",
          lastAt: data.timestamp,
          lastFrom: "ai",
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
    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        from: "ai",
        t: new Date(data.timestamp).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        body: data.message,
        agent: data.agentId,
      },
    });

    this.logger.debug(
      `l message from agent ${data.agentId} → conversation ${data.conversationId} in workspace ${workspace.id}`,
    );
    return { ok: true };
  }
}
