import { ConflictException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
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
    @Optional() private readonly perm?: PermissionService,
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

  async setForConversation(workspaceId: string, conversationId: string, labelIds: string[], viewer?: Viewer) {
    const ids = [...new Set(labelIds)];
    const scope = this.perm ? await this.perm.conversationScope(workspaceId, viewer) : {};
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId, ...scope },
      select: { id: true, channel: true, updatedAt: true },
    });
    if (!conv) throw new NotFoundException("Conversation not found");
    if (ids.length) {
      const found = await this.prisma.conversationLabel.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { id: true },
      });
      if (found.length !== ids.length) throw new NotFoundException("Label not found");
    }
    try {
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
          // updatedAt kept explicit: labelling must not reorder the inbox.
          data: { version: { increment: 1 }, updatedAt: conv.updatedAt },
        }),
      ]);
    } catch (e) {
      // A label deleted between the check and the write (FK violation).
      if ((e as { code?: string })?.code === "P2003") {
        throw new NotFoundException("Label not found");
      }
      throw e;
    }
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: conv.channel,
      conversationId,
    });
    return { labelIds: ids };
  }
}
