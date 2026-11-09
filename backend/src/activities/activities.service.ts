import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { NotificationsService } from "../notifications/notifications.service";
import {
  ACTIVITY_KINDS,
  BULK_MAX,
  BulkActivitiesDto,
  CompleteActivityDto,
  CreateActivityDto,
  DUE_REQUIRED_KINDS,
  ListActivitiesQuery,
  NextStepsQuery,
  QueueQuery,
  UpdateActivityDto,
} from "./activities.dto";
import { localDayBounds } from "./buckets";
import { canOpenRecord } from "../notifications/record-access";

const INCLUDE = {
  contact: { select: { id: true, name: true } },
  ticket: { select: { id: true, number: true, title: true } },
};
const PAGE = 50;
const QUEUE_CAP = 500;
const DEFAULT_TZ = "Asia/Riyadh";

type Action = "view" | "update" | "delete";
/** "all" = unrestricted (no viewer, bypass session or no PermissionService). */
type Eff = "all" | Awaited<ReturnType<PermissionService["effective"]>>;

@Injectable()
export class ActivitiesService {
  /** Overridable clock for tests. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  // ── permissions ─────────────────────────────────────────────────────────
  // An activity follows its link: ticket activities use tickets.*, the rest
  // contacts.*. Routes are "authenticated" in the permission map; these checks
  // are the enforcement.

  private async eff(ws: string, viewer?: Viewer | null): Promise<Eff> {
    if (!this.perm || !viewer || viewer.bypass) return "all";
    return this.perm.effective(ws, viewer.userId);
  }

  private can(eff: Eff, p: string): boolean {
    return eff === "all" || (!!this.perm && this.perm.can(eff, p));
  }

  private permFor(a: { ticketId?: string | null }, action: Action) {
    return a.ticketId ? `tickets.${action}` : `contacts.${action}`;
  }

  private async assertCan(ws: string, viewer: Viewer | undefined, a: { ticketId?: string | null }, action: Action) {
    if (!this.can(await this.eff(ws, viewer), this.permFor(a, action))) {
      throw new ForbiddenException("You do not have permission for this activity");
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private async load(ws: string, id: string) {
    const row = await this.prisma.activity.findFirst({ where: { id, workspaceId: ws }, include: INCLUDE });
    if (!row) throw new NotFoundException("Activity not found");
    return row;
  }

  private async assertMember(ws: string, userId: string) {
    const m = await this.prisma.workspaceMember.findFirst({ where: { workspaceId: ws, userId }, select: { userId: true } });
    if (!m) throw new NotFoundException("Assignee not found");
  }

  private parseDate(v: string, field: string): Date {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} is not a valid date`);
    return d;
  }

  private canAssigneeOpen(ws: string, userId: string, a: { ticketId?: string | null; contactId?: string | null }) {
    const id = a.ticketId ?? a.contactId;
    if (!id) return Promise.resolve(false);
    return canOpenRecord(this.prisma, ws, userId, a.ticketId ? "ticket" : "contact", id, this.perm);
  }

  private async assertAssigneeAccess(ws: string, userId: string, a: { ticketId?: string | null; contactId?: string | null }) {
    if (!(await this.canAssigneeOpen(ws, userId, a))) throw new BadRequestException("activities.assignee_no_access");
  }

  private async notifyAssigned(
    ws: string,
    act: { assigneeId?: string | null; title: string; ticketId?: string | null; contactId?: string | null; contact?: { name: string } | null },
    actorId: string | null,
  ) {
    if (!act.assigneeId || act.assigneeId === actorId) return;
    if (!(await this.canAssigneeOpen(ws, act.assigneeId, act))) return;
    const kind = act.ticketId ? "ticket" : "contact";
    const id = act.ticketId ?? act.contactId;
    if (!id) return;
    await this.notifications.notify(ws, [act.assigneeId], {
      type: "assignment",
      title: "assignment.activity",
      body: JSON.stringify({ title: act.title, contactName: act.contact?.name ?? "" }),
      recordKind: kind,
      recordId: id,
      actorId: actorId ?? undefined,
    });
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  async create(ws: string, dto: CreateActivityDto, actorId: string | null, viewer?: Viewer) {
    if (!ACTIVITY_KINDS.includes(dto.kind)) throw new BadRequestException("Unknown activity kind");
    const dueAt = dto.dueAt ? this.parseDate(dto.dueAt, "dueAt") : null;
    if (DUE_REQUIRED_KINDS.includes(dto.kind) && !dueAt) throw new BadRequestException("dueAt is required");
    if (!dto.contactId && !dto.ticketId) throw new BadRequestException("An activity needs a contact or a ticket");

    let contactId = dto.contactId ?? null;
    const ticketId = dto.ticketId ?? null;
    if (ticketId) {
      const t = await this.prisma.ticket.findFirst({ where: { id: ticketId, workspaceId: ws }, select: { id: true, contactId: true } });
      if (!t) throw new NotFoundException("Ticket not found");
      if (contactId && contactId !== t.contactId) throw new BadRequestException("contactId does not match the ticket's contact");
      contactId = t.contactId;
    } else {
      const c = await this.prisma.contact.findFirst({ where: { id: contactId!, workspaceId: ws }, select: { id: true } });
      if (!c) throw new NotFoundException("Contact not found");
    }
    if (dto.bookingId) {
      const b = await this.prisma.appointment.findFirst({ where: { id: dto.bookingId, workspaceId: ws }, select: { id: true } });
      if (!b) throw new NotFoundException("Booking not found");
    }
    const assigneeId = dto.assigneeId ?? actorId ?? null;
    if (dto.assigneeId) {
      await this.assertMember(ws, dto.assigneeId);
      await this.assertAssigneeAccess(ws, dto.assigneeId, { ticketId, contactId });
    }
    await this.assertCan(ws, viewer, { ticketId }, "update");

    const now = this.now();
    const logged = !DUE_REQUIRED_KINDS.includes(dto.kind);
    const doneAt = logged && !(dueAt && dueAt.getTime() > now.getTime()) ? now : null;
    const row = await this.prisma.activity.create({
      data: {
        workspaceId: ws,
        kind: dto.kind,
        title: dto.title,
        notes: dto.notes ?? null,
        dueAt,
        doneAt,
        outcome: dto.outcome ?? null,
        assigneeId,
        contactId,
        ticketId,
        bookingId: dto.bookingId ?? null,
        createdById: actorId,
      },
      include: INCLUDE,
    });
    await this.notifyAssigned(ws, row, actorId);
    return row;
  }

  async update(ws: string, id: string, dto: UpdateActivityDto, actorId: string | null, viewer?: Viewer) {
    const existing = await this.load(ws, id);
    await this.assertCan(ws, viewer, existing, "update");
    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.outcome !== undefined) data.outcome = dto.outcome;
    let rearm = false;
    if (dto.dueAt !== undefined) {
      if (dto.dueAt === null) {
        if (DUE_REQUIRED_KINDS.includes(existing.kind)) throw new BadRequestException("dueAt is required");
        data.dueAt = null;
      } else {
        const d = this.parseDate(dto.dueAt, "dueAt");
        data.dueAt = d;
        if (existing.dueAt?.getTime() !== d.getTime()) rearm = true;
      }
    }
    let newAssignee: string | null = null;
    if (dto.assigneeId !== undefined) {
      if (dto.assigneeId !== null && dto.assigneeId !== existing.assigneeId) {
        await this.assertMember(ws, dto.assigneeId);
        await this.assertAssigneeAccess(ws, dto.assigneeId, existing);
      }
      data.assigneeId = dto.assigneeId;
      if (dto.assigneeId !== existing.assigneeId) {
        rearm = true;
        newAssignee = dto.assigneeId;
      }
    }
    // A reschedule or reassignment re-arms the due notification.
    if (rearm) data.notifiedAt = null;
    const row = await this.prisma.activity.update({ where: { id }, data, include: INCLUDE });
    if (newAssignee) await this.notifyAssigned(ws, row, actorId);
    return row;
  }

  async complete(ws: string, id: string, dto: CompleteActivityDto, viewer?: Viewer) {
    const existing = await this.load(ws, id);
    await this.assertCan(ws, viewer, existing, "update");
    if (existing.doneAt) return existing;
    return this.prisma.activity.update({
      where: { id },
      data: { doneAt: this.now(), outcome: dto.outcome ?? existing.outcome },
      include: INCLUDE,
    });
  }

  async remove(ws: string, id: string, viewer?: Viewer) {
    const existing = await this.load(ws, id);
    await this.assertCan(ws, viewer, existing, "delete");
    await this.prisma.activity.delete({ where: { id } });
    return { ok: true };
  }

  async list(ws: string, q: ListActivitiesQuery, viewer?: Viewer) {
    if (!q.contactId && !q.ticketId) throw new BadRequestException("contactId or ticketId is required");
    const eff = await this.eff(ws, viewer);
    const where: Record<string, unknown> = { workspaceId: ws };
    if (q.ticketId) {
      if (!this.can(eff, "tickets.view")) throw new ForbiddenException("You do not have permission for this activity");
      const t = await this.prisma.ticket.findFirst({ where: { id: q.ticketId, workspaceId: ws }, select: { id: true } });
      if (!t) throw new NotFoundException("Ticket not found");
      where.ticketId = q.ticketId;
    } else {
      if (!this.can(eff, "contacts.view")) throw new ForbiddenException("You do not have permission for this activity");
      const c = await this.prisma.contact.findFirst({ where: { id: q.contactId!, workspaceId: ws }, select: { id: true } });
      if (!c) throw new NotFoundException("Contact not found");
      where.contactId = q.contactId;
      // ticket-linked rows on this contact need tickets.view
      if (!this.can(eff, "tickets.view")) where.ticketId = null;
    }
    const limit = q.limit ?? PAGE;
    const rows = await this.prisma.activity.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: INCLUDE,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  // ── follow-up queue ─────────────────────────────────────────────────────

  async queue(ws: string, q: QueueQuery, viewer?: Viewer) {
    const eff = await this.eff(ws, viewer);
    const empty = { overdue: [], today: [], upcoming: [], counts: { overdue: 0, today: 0, upcoming: 0 }, nextCursorUpcoming: null };
    const seeContacts = this.can(eff, "contacts.view");
    const seeTickets = this.can(eff, "tickets.view");
    if (!seeContacts && !seeTickets) return empty;

    const scope = q.scope === "team" ? "team" : "mine";
    const userId = viewer?.userId;
    const and: Record<string, unknown>[] = [];
    if (scope === "mine") {
      if (!userId) return empty;
      and.push({ assigneeId: userId });
    } else {
      if (q.assigneeId) and.push({ assigneeId: q.assigneeId });
      // Team scope is every activity on a record the viewer may open: the
      // contacts.view / tickets.view gates below are the access rule (contacts
      // and tickets are not row-scoped by conversation visibility).
    }
    if (q.kind) and.push({ kind: q.kind });
    if (q.pipelineId) and.push({ ticket: { pipelineId: q.pipelineId } });
    if (!seeTickets) and.push({ ticketId: null });
    if (!seeContacts) and.push({ ticketId: { not: null } });

    const tz = (await this.prisma.workspace.findUnique({ where: { id: ws }, select: { timezone: true } }))?.timezone || DEFAULT_TZ;
    const now = this.now();
    const { end } = localDayBounds(now, tz);
    const base = { workspaceId: ws, doneAt: null };
    const w = (range: Record<string, Date>) => ({ ...base, AND: [...and, { dueAt: range }] });
    const wOverdue = w({ lt: now });
    const wToday = w({ gte: now, lt: end });
    const wUpcoming = w({ gte: end });
    const order = [{ dueAt: "asc" as const }, { id: "asc" as const }];

    const [overdue, today, upcomingRows, cOver, cToday, cUp] = await Promise.all([
      this.prisma.activity.findMany({ where: wOverdue, orderBy: order, take: QUEUE_CAP, include: INCLUDE }),
      this.prisma.activity.findMany({ where: wToday, orderBy: order, take: QUEUE_CAP, include: INCLUDE }),
      this.prisma.activity.findMany({
        where: wUpcoming,
        orderBy: order,
        take: PAGE + 1,
        ...(q.cursorUpcoming ? { cursor: { id: q.cursorUpcoming }, skip: 1 } : {}),
        include: INCLUDE,
      }),
      this.prisma.activity.count({ where: wOverdue }),
      this.prisma.activity.count({ where: wToday }),
      this.prisma.activity.count({ where: wUpcoming }),
    ]);
    const hasMore = upcomingRows.length > PAGE;
    const upcoming = hasMore ? upcomingRows.slice(0, PAGE) : upcomingRows;
    return {
      overdue,
      today,
      upcoming,
      counts: { overdue: cOver, today: cToday, upcoming: cUp },
      nextCursorUpcoming: hasMore ? upcoming[upcoming.length - 1].id : null,
    };
  }

  // ── bulk ────────────────────────────────────────────────────────────────

  async bulk(ws: string, dto: BulkActivitiesDto, actorId: string | null, viewer?: Viewer) {
    const ids = [...new Set(dto.ids ?? [])];
    if (ids.length === 0 || ids.length > BULK_MAX) throw new BadRequestException(`Provide 1 to ${BULK_MAX} ids`);
    let dueAt: Date | undefined;
    if (dto.op === "reschedule") {
      if (!dto.dueAt) throw new BadRequestException("dueAt is required");
      dueAt = this.parseDate(dto.dueAt, "dueAt");
    } else if (dto.op === "reassign") {
      if (!dto.assigneeId) throw new BadRequestException("assigneeId is required");
      await this.assertMember(ws, dto.assigneeId);
    } else if (dto.op !== "done") {
      throw new BadRequestException("Unknown op");
    }

    // Only open activities in this workspace that the actor may update.
    const rows = await this.prisma.activity.findMany({
      where: { id: { in: ids }, workspaceId: ws, doneAt: null },
      select: { id: true, ticketId: true, contactId: true, title: true },
    });
    const eff = await this.eff(ws, viewer);
    let allowed = rows.filter((r) => this.can(eff, this.permFor(r, "update")));
    // A reassign target that cannot open a record is skipped for that row.
    if (dto.op === "reassign") {
      const ok = await Promise.all(allowed.map((r) => this.canAssigneeOpen(ws, dto.assigneeId!, r)));
      allowed = allowed.filter((_, i) => ok[i]);
    }
    const target = allowed.map((r) => r.id);
    if (target.length === 0) return { affected: 0, skipped: ids.length };

    const where = { id: { in: target }, workspaceId: ws, doneAt: null };
    let data: Record<string, unknown>;
    if (dto.op === "done") data = { doneAt: this.now() };
    else if (dto.op === "reassign") data = { assigneeId: dto.assigneeId, notifiedAt: null };
    else data = { dueAt, notifiedAt: null };
    const res = await this.prisma.activity.updateMany({ where, data });

    if (dto.op === "reassign" && res.count > 0 && dto.assigneeId !== actorId) {
      const one = allowed.length === 1 ? allowed[0] : null;
      await this.notifications.notify(ws, [dto.assigneeId!], {
        type: "assignment",
        title: "assignment.activity",
        body: JSON.stringify({ title: one?.title ?? "", count: res.count }),
        ...(one ? { recordKind: one.ticketId ? ("ticket" as const) : ("contact" as const), recordId: (one.ticketId ?? one.contactId)! } : {}),
        actorId: actorId ?? undefined,
      });
    }
    return { affected: res.count, skipped: ids.length - res.count };
  }

  // ── next steps ──────────────────────────────────────────────────────────

  /** The earliest open dated activity per contact/ticket: ONE query. */
  async nextSteps(ws: string, q: NextStepsQuery, viewer?: Viewer) {
    const hasC = !!q.contactIds?.length;
    const hasT = !!q.ticketIds?.length;
    if (hasC === hasT) throw new BadRequestException("Provide contactIds or ticketIds");
    const eff = await this.eff(ws, viewer);
    const field = hasC ? "contactId" : "ticketId";
    const list = (hasC ? q.contactIds : q.ticketIds)!;
    if (!this.can(eff, hasC ? "contacts.view" : "tickets.view")) throw new ForbiddenException("You do not have permission for this activity");
    const where: Record<string, unknown> = { workspaceId: ws, doneAt: null, dueAt: { not: null }, [field]: { in: list } };
    if (hasC && !this.can(eff, "tickets.view")) where.ticketId = null;

    const rows = await this.prisma.activity.findMany({
      where,
      orderBy: { dueAt: "asc" },
      distinct: [field],
      select: { id: true, kind: true, title: true, dueAt: true, contactId: true, ticketId: true },
    });
    const now = this.now().getTime();
    const out: Record<string, { activityId: string; kind: string; title: string; dueAt: Date; overdue: boolean }> = {};
    for (const r of rows) {
      const key = (r as Record<string, string | null>)[field];
      if (!key || !r.dueAt) continue;
      const cur = out[key];
      if (cur && cur.dueAt.getTime() <= r.dueAt.getTime()) continue;
      out[key] = { activityId: r.id, kind: r.kind, title: r.title, dueAt: r.dueAt, overdue: r.dueAt.getTime() < now };
    }
    return out;
  }
}
