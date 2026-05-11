import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateKeywordDto, UpdateKeywordDto } from "./keywords.dto";

@Injectable()
export class KeywordsService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string) {
    return this.prisma.keyword.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
  }

  async get(workspaceId: string, id: string) {
    const row = await this.prisma.keyword.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException("Keyword not found");
    return row;
  }

  create(workspaceId: string, dto: CreateKeywordDto) {
    return this.prisma.keyword.create({
      data: {
        workspaceId,
        value: dto.value,
        kind: dto.kind,
        enabled: dto.enabled ?? true,
        notes: dto.notes ?? null,
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateKeywordDto) {
    await this.get(workspaceId, id);
    return this.prisma.keyword.update({ where: { id }, data: dto });
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.prisma.keyword.delete({ where: { id } });
    return { ok: true };
  }
}
