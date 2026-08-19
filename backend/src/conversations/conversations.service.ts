import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import {
  CreateConversationDto,
  CreateMessageDto,
  UpdateConversationDto,
} from "./conversations.dto";

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  private emitActivity(
    workspaceId: string,
    channel: string,
    conversationId?: string,
  ): void {
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel,
      conversationId,
    });
  }

  async list(workspaceId: string) {
    const convs = await this.prisma.conversation.findMany({
      where: { workspaceId },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    });

    // 24-hour customer-service window state for WhatsApp conversations only.
    // Inbox uses it to flip the composer to a template picker when the window
    // closes. Other channels have different (or no) restrictions — skip the
    // extra query for them.
    const waConvIds = convs
      .filter((c) => c.channel === "whatsapp")
      .map((c) => c.id);
    const lastInboundByConv = new Map<string, Date>();
    if (waConvIds.length > 0) {
      const grouped = await this.prisma.message.groupBy({
        by: ["conversationId"],
        where: {
          workspaceId,
          conversationId: { in: waConvIds },
          from: "them",
        },
        _max: { createdAt: true },
      });
      for (const g of grouped) {
        if (g._max.createdAt) lastInboundByConv.set(g.conversationId, g._max.createdAt);
      }
    }

    const WA_WINDOW_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    return convs.map((c) => {
      if (c.channel !== "whatsapp") return c;
      const lastInboundAt = lastInboundByConv.get(c.id) ?? null;
      const waWindowOpen = lastInboundAt
        ? now - lastInboundAt.getTime() < WA_WINDOW_MS
        : false;
      return { ...c, lastInboundAt, waWindowOpen };
    });
  }

  async get(workspaceId: string, id: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!conv) throw new NotFoundException("Conversation not found");

    if (conv.channel === "whatsapp") {
      // Walk messages backwards for the most recent inbound. Avoids a second
      // query since we already have the full thread loaded.
      let lastInboundAt: Date | null = null;
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        if (conv.messages[i].from === "them") {
          lastInboundAt = conv.messages[i].createdAt;
          break;
        }
      }
      const WA_WINDOW_MS = 24 * 60 * 60 * 1000;
      const waWindowOpen = lastInboundAt
        ? Date.now() - lastInboundAt.getTime() < WA_WINDOW_MS
        : false;
      return { ...conv, lastInboundAt, waWindowOpen };
    }

    return conv;
  }

  async create(workspaceId: string, dto: CreateConversationDto) {
    const conv = await this.prisma.conversation.create({
      data: {
        ...dto,
        workspaceId,
        unread: 0,
        pinned: dto.pinned ?? false,
        escalated: dto.escalated ?? false,
      },
    });
    this.emitActivity(workspaceId, conv.channel, conv.id);
    return conv;
  }

  async update(workspaceId: string, id: string, dto: UpdateConversationDto) {
    await this.get(workspaceId, id);
    const conv = await this.prisma.conversation.update({ where: { id }, data: dto });
    this.emitActivity(workspaceId, conv.channel, conv.id);
    return conv;
  }

  async markRead(workspaceId: string, id: string) {
    const conv = await this.get(workspaceId, id);
    // Raw UPDATE on purpose: the list orders by updatedAt, and Prisma's
    // @updatedAt bumps on every model-level update — so opening a thread
    // (mark-read) would hoist it to the top. Reading must not reorder.
    await this.prisma.$executeRaw`
      UPDATE "Conversation" SET "unread" = 0
      WHERE "id" = ${id} AND "workspaceId" = ${workspaceId}`;
    this.emitActivity(workspaceId, conv.channel, conv.id);
    return { ...conv, unread: 0 };
  }

  async remove(workspaceId: string, id: string) {
    const existing = await this.get(workspaceId, id);
    await this.prisma.conversation.delete({ where: { id } });
    this.emitActivity(workspaceId, existing.channel, id);
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
    const conv = await this.get(workspaceId, conversationId);
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
    this.emitActivity(workspaceId, conv.channel, conversationId);
    return message;
  }
}
