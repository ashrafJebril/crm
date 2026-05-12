import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateContactDto, UpdateContactDto } from "./contacts.dto";

interface ContactRow {
  id: string;
  name: string;
  phone: string | null;
  industry: string;
  lifecycle: string;
  source: string;
  value: string | null;
  lastSeen: string;
  tags: string;
  convs: number;
}

const shape = (c: ContactRow) => ({
  id: c.id,
  name: c.name,
  phone: c.phone ?? "",
  industry: c.industry,
  lifecycle: c.lifecycle,
  source: c.source,
  value: c.value ?? "—",
  lastSeen: c.lastSeen,
  tags: JSON.parse(c.tags) as string[],
  convs: c.convs,
});

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string) {
    const rows = await this.prisma.contact.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(shape);
  }

  async get(workspaceId: string, id: string) {
    const row = await this.prisma.contact.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Contact not found");
    return shape(row);
  }

  async create(workspaceId: string, dto: CreateContactDto) {
    const row = await this.prisma.contact.create({
      data: {
        workspaceId,
        name: dto.name,
        phone: dto.phone ?? null,
        industry: dto.industry,
        lifecycle: dto.lifecycle,
        source: dto.source,
        value: dto.value ?? null,
        lastSeen: dto.lastSeen ?? "just now",
        tags: JSON.stringify(dto.tags ?? []),
        convs: dto.convs ?? 0,
      },
    });
    return shape(row);
  }

  async update(workspaceId: string, id: string, dto: UpdateContactDto) {
    await this.get(workspaceId, id);
    const row = await this.prisma.contact.update({
      where: { id },
      data: {
        ...dto,
        tags: dto.tags !== undefined ? JSON.stringify(dto.tags) : undefined,
      },
    });
    return shape(row);
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.prisma.contact.delete({ where: { id } });
    return { ok: true };
  }
}
