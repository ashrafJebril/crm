import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import {
  CreateConversationLabelDto,
  UpdateConversationLabelDto,
} from "./conversation-labels.dto";

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

@Injectable()
export class ConversationLabelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(workspaceId: string) {
    const rows = await this.prisma.conversationLabel.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      include: { _count: { select: { links: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      count: r._count.links,
    }));
  }

  async create(workspaceId: string, dto: CreateConversationLabelDto) {
    try {
      return await this.prisma.conversationLabel.create({
        data: { workspaceId, name: dto.name.trim(), color: dto.color },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException("label exists");
      throw e;
    }
  }

  async update(workspaceId: string, id: string, dto: UpdateConversationLabelDto) {
    const existing = await this.prisma.conversationLabel.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException("Label not found");
    const data: { name?: string; color?: string } = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.color !== undefined) data.color = dto.color;
    try {
      await this.prisma.conversationLabel.updateMany({ where: { id, workspaceId }, data });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException("label exists");
      throw e;
    }
    return this.prisma.conversationLabel.findFirst({ where: { id, workspaceId } });
  }

  async remove(workspaceId: string, id: string) {
    const existing = await this.prisma.conversationLabel.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException("Label not found");
    const unlinked = await this.prisma.conversationLabelLink.count({ where: { labelId: id } });
    await this.prisma.conversationLabel.deleteMany({ where: { id, workspaceId } });
    return { ok: true, unlinked };
  }

  async setForConversation(workspaceId: string, conversationId: string, labelIds: string[]) {
    const ids = [...new Set(labelIds)];
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true, channel: true },
    });
    if (!conv) throw new NotFoundException("Conversation not found");
    if (ids.length) {
      const found = await this.prisma.conversationLabel.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { id: true },
      });
      if (found.length !== ids.length) throw new NotFoundException("Label not found");
    }
    await this.prisma.$transaction([
      this.prisma.conversationLabelLink.deleteMany({
        where: { conversationId, labelId: { notIn: ids } },
      }),
      this.prisma.conversationLabelLink.createMany({
        data: ids.map((labelId) => ({ conversationId, labelId })),
        skipDuplicates: true,
      }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: { version: { increment: 1 } },
      }),
    ]);
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: conv.channel,
      conversationId,
    });
    return { labelIds: ids };
  }
}
