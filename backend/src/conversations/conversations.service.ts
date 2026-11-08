import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { LOutboundService } from "../integrations/l-outbound.service";
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
    private readonly lOutbound: LOutboundService,
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
      include: { labels: { select: { labelId: true } } },
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
    return convs.map(({ labels, ...rest }) => {
      const c = { ...rest, labelIds: labels.map((l) => l.labelId) };
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
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        labels: { select: { labelId: true } },
      },
    });
    if (!conv) throw new NotFoundException("Conversation not found");
    return this.withWindow(conv);
  }

  private withWindow<
    T extends {
      channel: string;
      messages: { from: string; createdAt: Date }[];
      labels: { labelId: string }[];
    },
  >(full: T) {
    const { labels, ...rest } = full;
    const conv = { ...rest, labelIds: labels.map((l) => l.labelId) };

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
    const row = await this.prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { labels: { select: { labelId: true } } },
    });
    if (!row) throw new NotFoundException("Conversation not found");
    if (dto.version !== undefined && dto.version !== row.version) {
      throw this.conflict(row);
    }

    if (typeof dto.assigneeId === "string") {
      const member = await this.prisma.workspaceMember.findFirst({
        where: { workspaceId, userId: dto.assigneeId },
      });
      if (!member) throw new BadRequestException("assignee is not a member");
    }

    const { version: _version, escalateReason, ...fields } = dto;
    const data: Record<string, unknown> = { ...fields };
    if (dto.escalated === true) {
      if (!escalateReason || !escalateReason.trim()) {
        throw new BadRequestException("escalateReason is required to escalate");
      }
      data.escalateReason = escalateReason.trim();
    } else if (dto.escalated === false) {
      data.escalateReason = null;
    }
    if (dto.status !== undefined && dto.status !== row.status) {
      data.statusChangedAt = new Date();
    }
    data.version = { increment: 1 };

    const res = await this.prisma.conversation.updateMany({
      where: { id, workspaceId, version: row.version },
      data,
    });
    const fresh = await this.prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { labels: { select: { labelId: true } } },
    });
    if (res.count === 0 || !fresh) {
      if (!fresh) throw new NotFoundException("Conversation not found");
      throw this.conflict(fresh);
    }
    this.emitActivity(workspaceId, fresh.channel, fresh.id);
    return this.mapLabels(fresh);
  }

  private mapLabels<T extends { labels: { labelId: string }[] }>(c: T) {
    const { labels, ...rest } = c;
    return { ...rest, labelIds: labels.map((l) => l.labelId) };
  }

  private conflict(current: { labels: { labelId: string }[] }) {
    return new ConflictException({
      message: "Conversation changed",
      current: this.mapLabels(current),
    });
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

  /**
   * Turn the AI on or off for one thread, and hand a paused thread back.
   *
   * Enabling always clears `aiPausedAt`: the operator flipping it on IS the
   * decision to let the agent speak again, so leaving a stale pause would make
   * the toggle look broken.
   */
  async setAi(
    workspaceId: string,
    conversationId: string,
    enabled: boolean,
  ) {
    await this.get(workspaceId, conversationId); // 404s if not in this workspace
    return await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { aiEnabled: enabled, aiPausedAt: null },
      select: { id: true, aiEnabled: true, aiPausedAt: true },
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
        // A human sending into an AI-handled thread takes it over: the agent
        // stops answering until someone clears the pause. Without this, staff
        // and the bot talk over each other in front of the customer — the
        // fastest way to destroy trust in the feature.
        //
        // 'ai' is excluded deliberately: the agent's own replies arrive through
        // this path too and must not pause itself.
        ...(dto.from === "human" ? { aiPausedAt: now } : {}),
      },
    });
    this.emitActivity(workspaceId, conv.channel, conversationId);

    // A reply typed here has to reach the l agent, or the person waiting in
    // that chat never hears back. "them" is the contact's own message arriving
    // by some other path and is not ours to forward. The call returns at once;
    // the agent's answer is written when it arrives.
    if (dto.from === "human") {
      this.lOutbound.queueReply(workspaceId, conversationId, dto.body);
    }
    return message;
  }
}
