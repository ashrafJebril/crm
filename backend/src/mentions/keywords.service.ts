import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateKeywordDto, UpdateKeywordDto } from "./keywords.dto";

@Injectable()
export class KeywordsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.keyword.findMany({ orderBy: { createdAt: "desc" } });
  }

  async get(id: string) {
    const row = await this.prisma.keyword.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Keyword not found");
    return row;
  }

  create(dto: CreateKeywordDto) {
    return this.prisma.keyword.create({
      data: {
        value: dto.value,
        kind: dto.kind,
        enabled: dto.enabled ?? true,
        notes: dto.notes ?? null,
      },
    });
  }

  async update(id: string, dto: UpdateKeywordDto) {
    await this.get(id);
    return this.prisma.keyword.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.keyword.delete({ where: { id } });
    return { ok: true };
  }
}
