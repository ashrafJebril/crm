import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  CreateConversationDto,
  CreateMessageDto,
  UpdateConversationDto,
} from "./conversations.dto";

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string) {
    return this.prisma.conversation.findMany({
      where: { workspaceId },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    });
  }

  async get(workspaceId: string, id: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!conv) throw new NotFoundException("Conversation not found");
    return conv;
  }

  create(workspaceId: string, dto: CreateConversationDto) {
    return this.prisma.conversation.create({
      data: {
        ...dto,
        workspaceId,
        unread: 0,
        pinned: dto.pinned ?? false,
        escalated: dto.escalated ?? false,
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateConversationDto) {
    await this.get(workspaceId, id);
    return this.prisma.conversation.update({ where: { id }, data: dto });
  }

  async markRead(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    return this.prisma.conversation.update({
      where: { id },
      data: { unread: 0 },
    });
  }

  /** Human takeover: when paused=true, AI auto-reply skips this conversation. */
  async setAiPaused(workspaceId: string, id: string, paused: boolean) {
    await this.get(workspaceId, id);
    return this.prisma.conversation.update({
      where: { id },
      data: {
        aiPaused: paused,
        // Also flip status so the Inbox filter reflects who's handling it.
        status: paused ? "human" : "ai",
        // Clear the escalated flag when AI is resumed — fresh start.
        ...(paused ? {} : { escalated: false }),
      },
    });
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.prisma.conversation.delete({ where: { id } });
    return { ok: true };
  }

  async listMessages(workspaceId: string, conversationId: string) {
    await this.get(workspaceId, conversationId);
    return this.prisma.message.findMany({
      where: { conversationId, workspaceId },
      orderBy: { createdAt: "asc" },
    });
  }

  async addMessage(
    workspaceId: string,
    conversationId: string,
    dto: CreateMessageDto,
  ) {
    await this.get(workspaceId, conversationId);
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const message = await this.prisma.message.create({
      data: { ...dto, conversationId, workspaceId, t },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        preview: dto.body.slice(0, 140),
        lastAt: "now",
        lastFrom: dto.from,
        unread: dto.from === "them" ? { increment: 1 } : 0,
      },
    });
    return message;
  }
}
