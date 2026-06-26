import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateContactDto, UpdateContactDto } from "./contacts.dto";
import { SegmentsService } from "../segments/segments.service";

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly segments: SegmentsService,
  ) {}

  async list(workspaceId: string, opts: { segmentId?: string } = {}) {
    const where = opts.segmentId
      ? this.segments.buildWhere(
          workspaceId,
          await this.segments.getFilter(workspaceId, opts.segmentId),
        )
      : { workspaceId };
    const rows = await this.prisma.contact.findMany({
      where,
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

  /**
   * Aggregated contact profile for the contacts drawer — stats + recent
   * activity in one round-trip so the drawer doesn't fire 4 separate GETs.
   */
  async summary(workspaceId: string, id: string) {
    const contact = await this.get(workspaceId, id);

    const [allConvs, allTicketsCount, recentTickets, totalMessages, totalNotes, totalAppointments] =
      await Promise.all([
        this.prisma.conversation.findMany({
          where: { contactId: id, workspaceId },
          orderBy: { updatedAt: "desc" },
        }),
        this.prisma.ticket.count({ where: { contactId: id, workspaceId } }),
        this.prisma.ticket.findMany({
          where: { contactId: id, workspaceId },
          orderBy: { updatedAt: "desc" },
          take: 5,
          include: { stage: true },
        }),
        this.prisma.message.count({
          where: { workspaceId, conversation: { contactId: id } },
        }),
        this.prisma.note.count({ where: { contactId: id, workspaceId } }),
        this.prisma.appointment.count({ where: { contactId: id, workspaceId } }),
      ]);

    const channels: Record<string, number> = {};
    for (const c of allConvs) {
      channels[c.channel] = (channels[c.channel] ?? 0) + 1;
    }

    return {
      contact,
      stats: {
        conversations: allConvs.length,
        messages: totalMessages,
        tickets: allTicketsCount,
        notes: totalNotes,
        appointments: totalAppointments,
        channels,
      },
      recentConversations: allConvs.slice(0, 5).map((c) => ({
        id: c.id,
        channel: c.channel,
        preview: c.preview,
        lastAt: c.lastAt,
        unread: c.unread,
        status: c.status,
      })),
      recentTickets: recentTickets.map((t) => ({
        id: t.id,
        number: t.number,
        title: t.title,
        value: t.value,
        currency: t.currency,
        closedAt: t.closedAt,
        stage: t.stage
          ? { label: t.stage.label, color: t.stage.color }
          : null,
      })),
    };
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
