import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { canOpenRecord } from "../notifications/record-access";
import { slaState } from "../tickets/ticket-sla";
import { BookingsService } from "../bookings/bookings.service";

export const RECORD_KINDS = ["contact", "conversation", "ticket", "booking", "campaign"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export type FieldValue = string | number | boolean | null;
export interface RecordField {
  key: string;
  value: FieldValue;
}
export interface RecordLink {
  kind: RecordKind;
  id: string;
  title: string;
  titleAr?: string;
  subtitle?: string;
  subtitleAr?: string;
  /** ISO; only on conversation links. */
  updatedAt?: string;
}
export interface RecordSummary {
  kind: RecordKind;
  id: string;
  title: string;
  titleAr?: string;
  subtitle?: string;
  subtitleAr?: string;
  fields: RecordField[];
  links: RecordLink[];
}

const LINK_LIMIT = 5;

function parseTags(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t) => typeof t === "string").join(", ") : "";
  } catch {
    return "";
  }
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * Compact, permission-checked record summaries for the universal record sheet.
 * Access is `canOpenRecord` (role `<resource>.view` + conversation visibility);
 * super-admin / impersonation sessions (no member row) only need existence in
 * the workspace. Every related-record link passes the same check, so a sheet
 * never advertises a record the viewer cannot open.
 */
@Injectable()
export class RecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perm: PermissionService,
  ) {}

  async get(workspaceId: string, viewer: Viewer, kind: string, id: string): Promise<RecordSummary> {
    if (!(RECORD_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException(`Unknown record kind "${kind}"`);
    }
    const k = kind as RecordKind;
    if (!(await this.canOpen(workspaceId, viewer, k, id))) throw new NotFoundException("Record not found");
    const summary = await this.load(workspaceId, viewer, k, id);
    if (!summary) throw new NotFoundException("Record not found");
    return summary;
  }

  private async canOpen(workspaceId: string, viewer: Viewer, kind: RecordKind, id: string): Promise<boolean> {
    if (viewer.bypass) {
      const where = { id, workspaceId };
      const select = { id: true };
      let row: unknown = null;
      switch (kind) {
        case "contact": row = await this.prisma.contact.findFirst({ where, select }); break;
        case "conversation": row = await this.prisma.conversation.findFirst({ where, select }); break;
        case "ticket": row = await this.prisma.ticket.findFirst({ where, select }); break;
        case "booking": row = await this.prisma.appointment.findFirst({ where, select }); break;
        case "campaign": row = await this.prisma.campaign.findFirst({ where, select }); break;
      }
      return !!row;
    }
    return canOpenRecord(this.prisma, workspaceId, viewer.userId, kind, id, this.perm);
  }

  /** Keep only the links the viewer may open. */
  private async filterLinks(workspaceId: string, viewer: Viewer, links: RecordLink[]): Promise<RecordLink[]> {
    const ok = await Promise.all(links.map((l) => this.canOpen(workspaceId, viewer, l.kind, l.id)));
    return links.filter((_, i) => ok[i]);
  }

  private async userName(workspaceId: string, userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    const u = await this.prisma.user.findFirst({
      where: { id: userId, memberships: { some: { workspaceId } } },
      select: { name: true },
    });
    return u?.name ?? null;
  }

  private async load(workspaceId: string, viewer: Viewer, kind: RecordKind, id: string): Promise<RecordSummary | null> {
    switch (kind) {
      case "contact": return this.contact(workspaceId, viewer, id);
      case "conversation": return this.conversation(workspaceId, viewer, id);
      case "ticket": return this.ticket(workspaceId, viewer, id);
      case "booking": return this.booking(workspaceId, viewer, id);
      case "campaign": return this.campaign(workspaceId, id);
    }
  }

  private async contact(workspaceId: string, viewer: Viewer, id: string): Promise<RecordSummary | null> {
    const c = await this.prisma.contact.findFirst({
      where: { id, workspaceId },
      include: { owner: { select: { name: true } } },
    });
    if (!c) return null;
    const scope = await this.perm.conversationScope(workspaceId, viewer);
    const [convs, tickets, bookings] = await Promise.all([
      this.prisma.conversation.findMany({
        where: { contactId: id, workspaceId, ...scope },
        orderBy: { updatedAt: "desc" },
        take: LINK_LIMIT,
        select: { id: true, channel: true, updatedAt: true },
      }),
      this.prisma.ticket.findMany({
        where: { contactId: id, workspaceId, closedAt: null },
        orderBy: { createdAt: "desc" },
        take: LINK_LIMIT,
        select: { id: true, number: true, title: true, stage: { select: { label: true, labelAr: true } } },
      }),
      this.prisma.appointment.findMany({
        where: { contactId: id, workspaceId, startAt: { gte: new Date() }, status: { not: "cancelled" } },
        orderBy: { startAt: "asc" },
        take: LINK_LIMIT,
        select: { id: true, service: true, serviceAr: true, startAt: true },
      }),
    ]);
    const links: RecordLink[] = [
      ...convs.map((v): RecordLink => ({ kind: "conversation", id: v.id, title: c.name, subtitle: v.channel, updatedAt: v.updatedAt.toISOString() })),
      ...tickets.map((t): RecordLink => ({
        kind: "ticket", id: t.id, title: `#${t.number} · ${t.title}`, subtitle: t.stage?.label,
        ...(t.stage?.labelAr ? { subtitleAr: t.stage.labelAr } : {}),
      })),
      ...bookings.map((b): RecordLink => ({
        kind: "booking", id: b.id, title: b.service, subtitle: b.startAt.toISOString(),
        ...(b.serviceAr ? { titleAr: b.serviceAr } : {}),
      })),
    ];
    return {
      kind: "contact",
      id: c.id,
      title: c.name,
      ...(c.phone ? { subtitle: c.phone } : {}),
      fields: [
        { key: "lifecycle", value: c.lifecycle },
        { key: "phone", value: c.phone ?? null },
        { key: "email", value: c.email ?? null },
        { key: "owner", value: c.owner?.name ?? null },
        { key: "tags", value: parseTags(c.tags) },
        { key: "createdAt", value: iso(c.createdAt) },
      ],
      links: await this.filterLinks(workspaceId, viewer, links),
    };
  }

  private async conversation(workspaceId: string, viewer: Viewer, id: string): Promise<RecordSummary | null> {
    const v = await this.prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: {
        contact: { select: { id: true, name: true, phone: true } },
        assignee: { select: { name: true } },
      },
    });
    if (!v) return null;
    const tickets = await this.prisma.ticket.findMany({
      where: { conversationId: id, workspaceId },
      orderBy: { createdAt: "desc" },
      take: LINK_LIMIT,
      select: { id: true, number: true, title: true, stage: { select: { label: true, labelAr: true } } },
    });
    const links: RecordLink[] = [
      {
        kind: "contact", id: v.contact.id, title: v.contact.name,
        ...(v.contact.phone ? { subtitle: v.contact.phone } : {}),
      },
      ...tickets.map((t): RecordLink => ({
        kind: "ticket", id: t.id, title: `#${t.number} · ${t.title}`, subtitle: t.stage?.label,
        ...(t.stage?.labelAr ? { subtitleAr: t.stage.labelAr } : {}),
      })),
    ];
    return {
      kind: "conversation",
      id: v.id,
      title: v.contact.name,
      subtitle: v.channel,
      fields: [
        { key: "channel", value: v.channel },
        { key: "status", value: v.status },
        { key: "assignee", value: v.assignee?.name ?? null },
        { key: "escalated", value: v.escalated },
        { key: "lastAt", value: v.lastAt },
        { key: "updatedAt", value: iso(v.updatedAt) },
      ],
      links: await this.filterLinks(workspaceId, viewer, links),
    };
  }

  private async ticket(workspaceId: string, viewer: Viewer, id: string): Promise<RecordSummary | null> {
    const t = await this.prisma.ticket.findFirst({
      where: { id, workspaceId },
      include: {
        pipeline: { select: { name: true } },
        stage: { select: { label: true, labelAr: true, isTerminal: true } },
        contact: { select: { id: true, name: true, phone: true } },
      },
    });
    if (!t) return null;
    const owner = await this.userName(workspaceId, t.ownerId);
    const links: RecordLink[] = [
      {
        kind: "contact", id: t.contact.id, title: t.contact.name,
        ...(t.contact.phone ? { subtitle: t.contact.phone } : {}),
      },
    ];
    if (t.conversationId) {
      // Only a DB conversation can be a record; opaque thread ids match no row.
      const conv = await this.prisma.conversation.findFirst({
        where: { id: t.conversationId, workspaceId },
        select: { id: true, channel: true, updatedAt: true },
      });
      if (conv) {
        links.push({
          kind: "conversation", id: conv.id, title: t.contact.name, subtitle: conv.channel,
          updatedAt: conv.updatedAt.toISOString(),
        });
      }
    }
    return {
      kind: "ticket",
      id: t.id,
      title: `#${t.number} · ${t.title}`,
      subtitle: t.contact.name,
      fields: [
        { key: "number", value: t.number },
        { key: "pipeline", value: t.pipeline?.name ?? null },
        { key: "stage", value: t.stage?.label ?? null },
        { key: "stageAr", value: t.stage?.labelAr ?? null },
        { key: "value", value: t.value ?? null },
        { key: "owner", value: owner },
        { key: "createdAt", value: iso(t.createdAt) },
        // SP-09: support fields. `sla` is slaState (none | finished | breached | due_soon | on_track).
        { key: "priority", value: t.priority ?? "normal" },
        { key: "category", value: t.category ?? null },
        { key: "slaDueAt", value: iso(t.slaDueAt) },
        { key: "sla", value: slaState({ slaDueAt: t.slaDueAt ?? null, stageIsTerminal: t.stage?.isTerminal ?? false }) },
      ],
      links: await this.filterLinks(workspaceId, viewer, links),
    };
  }

  private async booking(workspaceId: string, viewer: Viewer, id: string): Promise<RecordSummary | null> {
    const b = await this.prisma.appointment.findFirst({
      where: { id, workspaceId },
      include: { contact: { select: { id: true, name: true, phone: true } } },
    });
    if (!b) return null;
    // SP-10: the catalog resource, schedule fit and overlap of the booking.
    const [staff, [annotated], resource] = await Promise.all([
      this.userName(workspaceId, b.staffId),
      new BookingsService(this.prisma).annotate(workspaceId, [b]),
      b.resourceId
        ? this.prisma.staffResource.findFirst({ where: { id: b.resourceId, workspaceId }, select: { name: true } })
        : null,
    ]);
    return {
      kind: "booking",
      id: b.id,
      title: b.service,
      ...(b.serviceAr ? { titleAr: b.serviceAr } : {}),
      subtitle: b.contact.name,
      fields: [
        { key: "service", value: b.service },
        { key: "serviceAr", value: b.serviceAr || null },
        { key: "start", value: iso(b.startAt) },
        { key: "status", value: b.status },
        { key: "staff", value: staff },
        { key: "resource", value: resource?.name ?? null },
        { key: "fit", value: annotated.fit },
        { key: "conflict", value: annotated.conflict },
      ],
      links: await this.filterLinks(workspaceId, viewer, [
        {
          kind: "contact", id: b.contact.id, title: b.contact.name,
          ...(b.contact.phone ? { subtitle: b.contact.phone } : {}),
        },
      ]),
    };
  }

  private async campaign(workspaceId: string, id: string): Promise<RecordSummary | null> {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!c) return null;
    return {
      kind: "campaign",
      id: c.id,
      title: c.name,
      subtitle: c.channel,
      fields: [
        { key: "status", value: c.status },
        { key: "sent", value: c.sent },
        { key: "delivered", value: c.delivered },
        { key: "read", value: c.read },
        { key: "failed", value: c.failed },
      ],
      links: [],
    };
  }
}
