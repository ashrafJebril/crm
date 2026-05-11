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

  list() {
    return this.prisma.conversation.findMany({
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    });
  }

  async get(id: string) {
    const conv = await this.prisma.conversation.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!conv) throw new NotFoundException("Conversation not found");
    return conv;
  }

  create(dto: CreateConversationDto) {
    return this.prisma.conversation.create({
      data: {
        ...dto,
        unread: 0,
        pinned: dto.pinned ?? false,
        escalated: dto.escalated ?? false,
      },
    });
  }

  async update(id: string, dto: UpdateConversationDto) {
    await this.get(id);
    return this.prisma.conversation.update({ where: { id }, data: dto });
  }

  async markRead(id: string) {
    await this.get(id);
    return this.prisma.conversation.update({
      where: { id },
      data: { unread: 0 },
    });
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.conversation.delete({ where: { id } });
    return { ok: true };
  }

  // ── messages ────────────────────────────────────────────────────────────
  listMessages(conversationId: string) {
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
  }

  async addMessage(conversationId: string, dto: CreateMessageDto) {
    await this.get(conversationId);
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const message = await this.prisma.message.create({
      data: { ...dto, conversationId, t },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        preview: dto.body.slice(0, 140),
        lastAt: "now",
        lastFrom: dto.from,
        // Reading from your side resets unread; an inbound bumps it.
        unread:
          dto.from === "them"
            ? { increment: 1 }
            : 0,
      },
    });
    return message;
  }
}
