import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ListMentionsQuery, UpdateMentionDto } from "./mentions.dto";

@Injectable()
export class MentionsService {
  constructor(private readonly prisma: PrismaService) {}

  list(q: ListMentionsQuery) {
    return this.prisma.mention.findMany({
      where: {
        status: q.status,
        keywordId: q.keywordId,
        source: q.source,
      },
      orderBy: { ingestedAt: "desc" },
      take: 200,
      include: { keyword: true },
    });
  }

  async get(id: string) {
    const row = await this.prisma.mention.findUnique({
      where: { id },
      include: { keyword: true },
    });
    if (!row) throw new NotFoundException("Mention not found");
    return row;
  }

  async update(id: string, dto: UpdateMentionDto) {
    await this.get(id);
    return this.prisma.mention.update({ where: { id }, data: dto });
  }
}
