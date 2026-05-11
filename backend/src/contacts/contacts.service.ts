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

  async list() {
    const rows = await this.prisma.contact.findMany({
      orderBy: { createdAt: "desc" },
    });
    return rows.map(shape);
  }

  async get(id: string) {
    const row = await this.prisma.contact.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Contact not found");
    return shape(row);
  }

  async create(dto: CreateContactDto) {
    const row = await this.prisma.contact.create({
      data: {
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

  async update(id: string, dto: UpdateContactDto) {
    await this.get(id);
    const row = await this.prisma.contact.update({
      where: { id },
      data: {
        ...dto,
        tags: dto.tags !== undefined ? JSON.stringify(dto.tags) : undefined,
      },
    });
    return shape(row);
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.contact.delete({ where: { id } });
    return { ok: true };
  }
}
