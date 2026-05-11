import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ListMentionsQuery, UpdateMentionDto } from "./mentions.dto";

const LIST_LIMIT = 200; // Phase 1 — replace with cursor pagination if volume grows

@Injectable()
export class MentionsService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string, q: ListMentionsQuery) {
    return this.prisma.mention.findMany({
      where: {
        workspaceId,
        status: q.status,
        keywordId: q.keywordId,
        source: q.source,
      },
      orderBy: { ingestedAt: "desc" },
      take: LIST_LIMIT,
      include: { keyword: true },
    });
  }

  async get(workspaceId: string, id: string) {
    const row = await this.prisma.mention.findFirst({
      where: { id, workspaceId },
      include: { keyword: true },
    });
    if (!row) throw new NotFoundException("Mention not found");
    return row;
  }

  async update(workspaceId: string, id: string, dto: UpdateMentionDto) {
    await this.get(workspaceId, id);
    return this.prisma.mention.update({
      where: { id },
      data: dto,
      include: { keyword: true },
    });
  }
}
