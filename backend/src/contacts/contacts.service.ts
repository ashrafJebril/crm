import { Prisma } from "@prisma/client";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { isEmail } from "class-validator";
import { joinName, normalizeDigits, splitName } from "./contact-name";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PrismaService } from "../prisma/prisma.service";
import { CreateContactDto, UpdateContactDto } from "./contacts.dto";
import { SegmentsService } from "../segments/segments.service";
import { WORKFLOW_TRIGGER_EVENT, WorkflowTriggerEvent } from "../workflows/workflow-events";
import { buildContactWhere, type ContactListFilter } from "./contact-filter";
import { HjzClientSyncService } from "../hjz-sync/hjz-client-sync.service";

export const SELECT_ALL_CAP = 10_000;

interface ContactRow {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  ownerId: string | null;
  marketingOptOut: boolean;
  notALead: boolean;
  createdAt: Date;
  phone: string | null;
  industry: string;
  lifecycle: string;
  source: string;
  value: string | null;
  lastSeen: string;
  tags: string;
  convs: number;
}

function parseTags(raw: string): string[] {
  // tags is a JSON-encoded string array. A single malformed row must not throw
  // and take down the whole contacts list — fall back to empty.
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

const shape = (c: ContactRow) => ({
  id: c.id,
  name: c.name,
  firstName: c.firstName,
  lastName: c.lastName,
  email: c.email ?? "",
  ownerId: c.ownerId,
  marketingOptOut: c.marketingOptOut,
  notALead: c.notALead,
  createdAt: c.createdAt,
  phone: c.phone ?? "",
  industry: c.industry,
  lifecycle: c.lifecycle,
  source: c.source,
  value: c.value ?? "—",
  lastSeen: c.lastSeen,
  tags: parseTags(c.tags),
  convs: c.convs,
});

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly segments: SegmentsService,
    @Optional() private readonly events?: EventEmitter2,
    @Optional() private readonly hjzSync?: HjzClientSyncService,
  ) {}

  async list(workspaceId: string, opts: { segmentId?: string } = {}) {
    // Origin-aware: manual groups and hjz segments resolve by membership, crm
    // segments by their saved filter. Never run a non-crm segment's inert
    // filter — "{}" would degenerate to the whole workspace under the group's
    // name (with the bulk bar's destructive actions attached to it).
    const where = opts.segmentId
      ? await this.segments.resolveContactWhere(workspaceId, opts.segmentId)
      : { workspaceId };
    const rows = await this.prisma.contact.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(shape);
  }

  /**
   * One page of contacts for the Contacts table: the full shared filter
   * (segment, search on name/phone/email, lifecycle, tags, owner, pipeline,
   * consent flags, custom fields), newest first. `list` stays for callers that
   * need everyone (audience pickers, group editors).
   */
  async listPage(workspaceId: string, opts: ContactListFilter & { page: number; pageSize: number }) {
    const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize) || 50, 1), 200);
    const page = Math.max(Math.trunc(opts.page) || 1, 1);
    const where = await buildContactWhere(workspaceId, opts, this.filterDeps());
    const [rows, total] = await Promise.all([
      this.prisma.contact.findMany({
        where,
        // id breaks createdAt ties so rows never repeat or vanish between pages.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.contact.count({ where }),
    ]);
    return {
      items: rows.map(shape),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  private filterDeps() {
    return { prisma: this.prisma, segments: this.segments };
  }

  /** Ids matching a filter for "select all N" — capped at SELECT_ALL_CAP. */
  async listIds(workspaceId: string, filter: ContactListFilter) {
    const where = await buildContactWhere(workspaceId, filter, this.filterDeps());
    const [rows, total] = await Promise.all([
      this.prisma.contact.findMany({
        where,
        select: { id: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: SELECT_ALL_CAP,
      }),
      this.prisma.contact.count({ where }),
    ]);
    return { ids: rows.map((r) => r.id), total, truncated: total > SELECT_ALL_CAP };
  }

  private async assertContact(workspaceId: string, id: string) {
    const c = await this.prisma.contact.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!c) throw new NotFoundException("Contact not found");
  }

  private paging(opts: { page: number; pageSize: number }) {
    const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize) || 20, 1), 50);
    const page = Math.max(Math.trunc(opts.page) || 1, 1);
    return { page, pageSize, skip: (page - 1) * pageSize };
  }

  async pagedTickets(workspaceId: string, contactId: string, opts: { page: number; pageSize: number }) {
    await this.assertContact(workspaceId, contactId);
    const { page, pageSize, skip } = this.paging(opts);
    const where = { contactId, workspaceId };
    const [items, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: { stage: true },
        skip,
        take: pageSize,
      }),
      this.prisma.ticket.count({ where }),
    ]);
    return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async pagedAppointments(workspaceId: string, contactId: string, opts: { page: number; pageSize: number }) {
    await this.assertContact(workspaceId, contactId);
    const { page, pageSize, skip } = this.paging(opts);
    const where = { contactId, workspaceId };
    const [items, total] = await Promise.all([
      this.prisma.appointment.findMany({
        where,
        orderBy: [{ startAt: "desc" }, { id: "desc" }],
        skip,
        take: pageSize,
      }),
      this.prisma.appointment.count({ where }),
    ]);
    return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
  }

  /** Real numbers for the Contacts header. */
  async stats(workspaceId: string) {
    const groups = await this.prisma.contact.groupBy({
      by: ["lifecycle"],
      where: { workspaceId },
      _count: { _all: true },
    });
    let total = 0;
    let leads = 0;
    let customers = 0;
    for (const g of groups) {
      total += g._count._all;
      const lc = g.lifecycle.toLowerCase();
      if (lc === "lead") leads += g._count._all;
      if (lc === "customer") customers += g._count._all;
    }
    return { total, leads, customers };
  }

  async get(workspaceId: string, id: string) {
    const row = await this.prisma.contact.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Contact not found");
    return shape(row);
  }

  async search(workspaceId: string, query: string) {
    const rows = await this.prisma.contact.findMany({
      where: {
        workspaceId,
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { phone: { contains: query, mode: "insensitive" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return rows.map(shape);
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

  private async assertOwner(workspaceId: string, ownerId: string | null | undefined) {
    if (typeof ownerId !== "string") return;
    const member = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, userId: ownerId } });
    if (!member) throw new BadRequestException("owner is not a member");
  }

  private cleanEmail(email: string | null | undefined): string | null | undefined {
    if (email === undefined || email === null) return email;
    const e = email.trim().toLowerCase();
    if (!e) return null;
    if (!isEmail(e)) throw new BadRequestException("email must be an email");
    return e;
  }

  /** Name/firstName/lastName stay in sync; '' counts as absent. */
  private nameFields(
    dto: { name?: string; firstName?: string; lastName?: string },
    stored?: { firstName: string | null; lastName: string | null },
  ): { name: string; firstName: string | null; lastName: string | null } | null {
    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      const first = dto.firstName ?? stored?.firstName ?? "";
      const last = dto.lastName ?? stored?.lastName ?? "";
      const name = joinName(first, last);
      if (!name) throw new BadRequestException("name is required");
      return { name, firstName: first.trim() || null, lastName: last.trim() || null };
    }
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException("name is required");
      const { firstName, lastName } = splitName(name);
      return { name, firstName, lastName };
    }
    return null;
  }

  async create(workspaceId: string, dto: CreateContactDto) {
    const names = this.nameFields(dto);
    if (!names) throw new BadRequestException("name is required");
    const email = this.cleanEmail(dto.email);
    await this.assertOwner(workspaceId, dto.ownerId);
    const row = await this.prisma.contact.create({
      data: {
        workspaceId,
        ...names,
        email: email ?? null,
        ownerId: dto.ownerId ?? null,
        marketingOptOut: dto.marketingOptOut ?? false,
        notALead: dto.notALead ?? false,
        phone: dto.phone != null ? normalizeDigits(dto.phone) : null,
        industry: dto.industry,
        lifecycle: dto.lifecycle,
        source: dto.source,
        value: dto.value ?? null,
        lastSeen: dto.lastSeen ?? "just now",
        tags: JSON.stringify(dto.tags ?? []),
        convs: dto.convs ?? 0,
      },
    });
    const shaped = shape(row);
    this.events?.emit(WORKFLOW_TRIGGER_EVENT, {
      workspaceId,
      triggerType: "contact_created",
      payload: { contact: shaped },
    } satisfies WorkflowTriggerEvent);
    // Connected to HJZ → create the customer there now (the sweep retries).
    void this.hjzSync?.pushContact(row.id);
    return shaped;
  }

  async update(workspaceId: string, id: string, dto: UpdateContactDto) {
    const stored = await this.prisma.contact.findFirst({ where: { id, workspaceId } });
    if (!stored) throw new NotFoundException("Contact not found");
    const names = this.nameFields(dto, stored);
    const email = this.cleanEmail(dto.email);
    await this.assertOwner(workspaceId, dto.ownerId);
    const row = await this.prisma.contact.update({
      where: { id },
      data: {
        ...dto,
        ...(names ?? {}),
        email,
        phone: dto.phone != null ? normalizeDigits(dto.phone) : dto.phone,
        tags: dto.tags !== undefined ? JSON.stringify(dto.tags) : undefined,
      },
    });
    return shape(row);
  }

  async remove(workspaceId: string, id: string, force = false) {
    await this.get(workspaceId, id);
    if (!force) {
      const [tickets, appointments] = await Promise.all([
        this.prisma.ticket.count({ where: { contactId: id, workspaceId } }),
        this.prisma.appointment.count({ where: { contactId: id, workspaceId } }),
      ]);
      if (tickets > 0 || appointments > 0) {
        throw new ConflictException({
          message: "Contact has linked records",
          linked: { tickets, appointments },
        });
      }
    }
    await this.prisma.contact.delete({ where: { id } });
    return { ok: true };
  }
}
