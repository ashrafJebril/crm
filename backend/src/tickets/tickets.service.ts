import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import {
  AddNoteDto,
  CreateTicketDto,
  ListTicketsQuery,
  MoveTicketDto,
  ResolveTicketDto,
  UpdateTicketDto,
} from "./tickets.dto";
import { WORKFLOW_TRIGGER_EVENT, WorkflowTriggerEvent } from "../workflows/workflow-events";
import { DEFAULT_TZ } from "../activities/buckets";
import { assignConversationToTicketOwner } from "./ticket-conversation-assign";
import { UNDO_NOTE, undoRefusal } from "./undo-stage";
import {
  PRIORITY_BUCKETS,
  TICKET_SORTS,
  buildTicketWhere,
  decodeCursor,
  encodeCursor,
  priorityBucketOrder,
  ticketCursorWhere,
  ticketOrderBy,
  type SortDir,
  type TicketSort,
} from "./ticket-filter";
import { TICKET_CATEGORIES, TICKET_PRIORITIES } from "./ticket-fields";
import { ticketError } from "./ticket-errors";

/** Marker activity: this card changed the contact's lifecycle (note "lifecycle:<from>-><to>"). */
export const LIFECYCLE_ACTIVITY = "lifecycle_changed";

/** SP-09: the channel of a ticket's conversation, derived at read time (ruling 4). */
export interface TicketChannelDto {
  kind: string;
  channelId: string | null;
  displayName: string | null;
}

/** SP-09: a booking card on the ticket sheet (ruling 7). */
export interface TicketBookingCardDto {
  id: string;
  startAt: Date;
  durationMin: number;
  status: string;
  service: string;
  serviceAr: string;
  staffId: string | null;
  source: string;
  hjzSyncError: string | null;
}

/** Booking cards: upcoming pending/confirmed bookings, from one day back, at most this many. */
export const TICKET_BOOKINGS_MAX = 20;
const TICKET_BOOKINGS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * SP-09: priority / category from a DTO (internal callers skip the
 * ValidationPipe). Unknown values are 400, never coerced; `null` category
 * clears it.
 */
function assertTicketFields(d: { priority?: unknown; category?: unknown }) {
  if (d.priority !== undefined && !(TICKET_PRIORITIES as readonly unknown[]).includes(d.priority)) {
    throw ticketError("tickets.invalid_priority");
  }
  if (d.category !== undefined && d.category !== null && !(TICKET_CATEGORIES as readonly unknown[]).includes(d.category)) {
    throw ticketError("tickets.invalid_category");
  }
}

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    @Optional() private readonly events?: EventEmitter2,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  // Pipelines (list/get/edit) live in PipelinesService (SP-07).

  // ─── Tickets ───────────────────────────────────────────────────────────
  async listTickets(workspaceId: string, query: ListTicketsQuery, viewer?: Viewer) {
    const take = query.limit ?? 50;
    // One builder for table and kanban, so the same filters always match the same tickets.
    const tz = query.from || query.to ? await this.workspaceTimezone(workspaceId) : DEFAULT_TZ;
    const where = buildTicketWhere(workspaceId, query, tz);

    if (query.view === "table") {
      const sort: TicketSort = (query.sort ?? "updatedAt") as TicketSort;
      if (!TICKET_SORTS.includes(sort)) throw new BadRequestException("Unknown sort field");
      const dir: SortDir = query.dir === "asc" ? "asc" : "desc";
      const [rows, total] = await Promise.all([
        sort === "priority"
          ? this.priorityPage(where, dir, take + 1, query.cursor)
          : this.prisma.ticket.findMany({
              where: query.cursor
                ? { AND: [where, ticketCursorWhere(sort, dir, decodeCursor(query.cursor, sort))] }
                : where,
              orderBy: ticketOrderBy(sort, dir),
              take: take + 1,
              include: { contact: true, stage: true },
            }),
        this.prisma.ticket.count({ where }),
      ]);
      const hasMore = rows.length > take;
      const page = hasMore ? rows.slice(0, take) : rows;
      return {
        items: await this.decorate(workspaceId, page, viewer),
        nextCursor: hasMore ? encodeCursor(sort, page[page.length - 1]) : null,
        total,
      };
    }

    const items = await this.prisma.ticket.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: take + 1,
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      include: {
        contact: true,
        stage: true,
      },
    });
    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return {
      items: await this.decorate(workspaceId, page, viewer),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * SP-09 `sort=priority`: rank order (urgent → low for desc), id within a
   * rank. Prisma cannot order by a CASE, so walk the rank buckets in order,
   * starting inside the cursor's bucket after its id (a stable keyset).
   */
  private async priorityPage(where: Prisma.TicketWhereInput, dir: SortDir, want: number, cursor?: string) {
    const order = priorityBucketOrder(dir);
    const c = cursor ? decodeCursor(cursor, "priority") : null;
    const start = c ? order.indexOf(c.v as number) : 0;
    const rows: Prisma.TicketGetPayload<{ include: { contact: true; stage: true } }>[] = [];
    for (let k = start; k < order.length && rows.length < want; k++) {
      const and: Prisma.TicketWhereInput[] = [where, PRIORITY_BUCKETS[order[k]]];
      if (c && k === start) and.push(ticketCursorWhere("priority", dir, c));
      rows.push(
        ...(await this.prisma.ticket.findMany({
          where: { AND: and },
          orderBy: ticketOrderBy("priority", dir),
          take: want - rows.length,
          include: { contact: true, stage: true },
        })),
      );
    }
    return rows;
  }

  /**
   * SP-09 DTO additions on list rows and getTicket:
   * - `channel`: from the linked conversation when the viewer can see it, else
   *   null (ruling 4, 10);
   * - `attachmentCount`: staff files, plus customer files only when the
   *   conversation is visible (a hidden attachment is not counted, ruling 10).
   */
  private async decorate<T extends { id: string; conversationId: string | null }>(
    workspaceId: string,
    rows: T[],
    viewer?: Viewer,
  ): Promise<Array<T & { channel: TicketChannelDto | null; attachmentCount: number }>> {
    if (rows.length === 0) return [];
    const convIds = [...new Set(rows.map((r) => r.conversationId).filter((x): x is string => !!x))];
    const channels = new Map<string, TicketChannelDto>();
    // Same rule as TicketAttachmentsService.conversationVisible (review M3): an
    // unrestricted viewer's customer files count even if the conversation row
    // is gone (they are listed and must stay unlinkable); a restricted viewer
    // needs the row inside their scope.
    let unrestricted = true;
    if (convIds.length > 0) {
      const scope = this.perm ? await this.perm.conversationScope(workspaceId, viewer) : {};
      unrestricted = Object.keys(scope).length === 0;
      const convs = await this.prisma.conversation.findMany({
        where: { AND: [{ id: { in: convIds }, workspaceId }, scope] },
        select: { id: true, channel: true, channelId: true, channelRef: { select: { kind: true, displayName: true } } },
      });
      for (const c of convs) {
        channels.set(c.id, {
          kind: c.channelRef?.kind ?? c.channel,
          channelId: c.channelId ?? null,
          displayName: c.channelRef?.displayName ?? null,
        });
      }
    }
    const groups = await this.prisma.ticketAttachment.groupBy({
      by: ["ticketId", "source"],
      where: { workspaceId, ticketId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    return rows.map((r) => {
      const channel = r.conversationId ? (channels.get(r.conversationId) ?? null) : null;
      const customerVisible = !!r.conversationId && (unrestricted || !!channel);
      let attachmentCount = 0;
      for (const g of groups) {
        if (g.ticketId !== r.id) continue;
        if (g.source === "customer" && !customerVisible) continue;
        attachmentCount += g._count._all;
      }
      return { ...r, channel, attachmentCount };
    });
  }

  private async workspaceTimezone(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } });
    return ws?.timezone || DEFAULT_TZ;
  }

  /** The ticket with the SP-09 DTO additions (`channel` under the viewer's scope, `attachmentCount`). */
  async getTicket(workspaceId: string, id: string, viewer?: Viewer) {
    const [t] = await this.decorate(workspaceId, [await this.findTicket(workspaceId, id)], viewer);
    return t;
  }

  private async findTicket(workspaceId: string, id: string) {
    const t = await this.prisma.ticket.findFirst({
      where: { id, workspaceId },
      include: {
        contact: true,
        stage: true,
        pipeline: { include: { stages: { orderBy: { order: "asc" } } } },
        activities: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!t) throw new NotFoundException("Ticket not found");
    return t;
  }

  /**
   * Assert that each supplied foreign-key id belongs to this workspace.
   * contactId / conversationId are workspace-scoped rows; ownerId must be a
   * member of the workspace (checked via WorkspaceMember, which is NOT covered
   * by the tenancy extension). Throws BadRequestException on any mismatch.
   */
  private async assertTicketRefs(
    workspaceId: string,
    refs: {
      contactId?: string;
      conversationId?: string | null;
      ownerId?: string | null;
    },
  ) {
    if (refs.contactId) {
      const c = await this.prisma.contact.findFirst({
        where: { id: refs.contactId, workspaceId },
        select: { id: true },
      });
      if (!c) throw new BadRequestException("contactId does not belong to this workspace");
    }
    if (refs.conversationId) {
      const cv = await this.prisma.conversation.findFirst({
        where: { id: refs.conversationId, workspaceId },
        select: { id: true },
      });
      if (!cv) throw new BadRequestException("conversationId does not belong to this workspace");
    }
    if (refs.ownerId) {
      const m = await this.prisma.workspaceMember.findFirst({
        where: { userId: refs.ownerId, workspaceId },
        select: { id: true },
      });
      if (!m) throw new BadRequestException("ownerId is not a member of this workspace");
    }
  }

  async createTicket(workspaceId: string, dto: CreateTicketDto, actorId?: string) {
    assertTicketFields(dto);
    // Validate pipeline and stage and that the stage belongs to the pipeline.
    const stage = await this.prisma.ticketStage.findFirst({
      where: { id: dto.stageId, workspaceId },
    });
    if (!stage || stage.pipelineId !== dto.pipelineId) {
      throw new BadRequestException("stageId does not belong to pipelineId");
    }
    // Archived pipelines are read-only for new work (their tickets stay readable).
    const pl = await this.prisma.pipeline.findFirst({
      where: { id: dto.pipelineId, workspaceId },
      select: { archivedAt: true, kind: true, assignsConversations: true },
    });
    if (pl?.archivedAt) throw new BadRequestException("pipelines.archived");

    // Reject foreign-key ids from other tenants — otherwise a ticket created in
    // your own workspace could point at another workspace's contact and leak
    // that contact's name/phone back through getTicket's `include: {contact}`.
    await this.assertTicketRefs(workspaceId, {
      contactId: dto.contactId,
      conversationId: dto.conversationId,
      ownerId: dto.ownerId,
    });

    // Per-pipeline, per-workspace auto-incrementing number. Read-max-then-+1
    // races under concurrent creates and collides on @@unique([pipelineId,
    // number]); retry on that specific conflict with a freshly recomputed
    // number instead of 500-ing / losing the ticket.
    const insert = async (db: any) => {
      const lastInPipeline = await db.ticket.findFirst({
        where: { pipelineId: dto.pipelineId, workspaceId },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      const number = (lastInPipeline?.number ?? 0) + 1;
      return db.ticket.create({
        data: {
          workspaceId,
          number,
          pipelineId: dto.pipelineId,
          stageId: dto.stageId,
          contactId: dto.contactId,
          conversationId: dto.conversationId ?? null,
          ownerId: dto.ownerId ?? null,
          title: dto.title,
          description: dto.description ?? null,
          value: dto.value ?? null,
          currency: "SAR",
          // Created straight into a terminal stage: it is closed from the start.
          closedAt: stage.isTerminal ? new Date() : null,
          // SP-09. slaDueAt is set by the "ticket_sla_due_at" trigger.
          ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
          category: dto.category ?? null,
        },
        include: { contact: true, stage: true },
      });
    };
    // SP-08: a leads pipeline keeps one open card per contact (see withLeadGuard).
    const isLeads = pl?.kind === "leads";
    let ticket: Prisma.PromiseReturnType<typeof this.prisma.ticket.create> | null =
      null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        ticket = isLeads
          ? await this.withLeadGuard(workspaceId, dto.pipelineId, dto.contactId, undefined, insert)
          : await insert(this.prisma);
        break;
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002" &&
          attempt < 4
        ) {
          continue; // number taken by a concurrent create — recompute + retry
        }
        throw e;
      }
    }
    if (!ticket) {
      throw new BadRequestException(
        "Could not allocate a ticket number — too many concurrent creates, please retry",
      );
    }

    await this.prisma.ticketActivity.create({
      data: {
        workspaceId,
        ticketId: ticket.id,
        kind: "created",
        toStage: stage.key,
      },
    });

    this.realtime.emitToWorkspace(workspaceId, "ticket.created", { ticket });

    if (dto.ownerId && dto.conversationId && pl?.assignsConversations) {
      await this.syncConversationOwner(workspaceId, dto.conversationId, dto.ownerId, actorId);
    }

    if (dto.ownerId && dto.ownerId !== actorId) {
      await this.notifyTicketOwner(workspaceId, dto.ownerId, ticket.id, ticket.title, actorId);
    }

    this.events?.emit(WORKFLOW_TRIGGER_EVENT, {
      workspaceId,
      triggerType: "ticket_created",
      payload: { ticket },
    } satisfies WorkflowTriggerEvent);

    return ticket;
  }

  async updateTicket(
    workspaceId: string,
    id: string,
    dto: UpdateTicketDto,
    actorId?: string,
  ) {
    const existing = await this.prisma.ticket.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException("Ticket not found");
    assertTicketFields(dto);

    // A reassigned owner must be a member of this workspace.
    await this.assertTicketRefs(workspaceId, { ownerId: dto.ownerId });

    const updated = await this.prisma.ticket.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        value: dto.value,
        ownerId: dto.ownerId,
        // SP-09: undefined leaves a field alone; a null category clears it.
        priority: dto.priority,
        category: dto.category,
      },
      include: { contact: true, stage: true },
    });

    if (dto.value !== undefined && dto.value !== existing.value) {
      await this.prisma.ticketActivity.create({
        data: {
          workspaceId,
          ticketId: id,
          kind: "value_changed",
          note: `${existing.value ?? 0} → ${dto.value}`,
        },
      });
    }
    if (dto.ownerId !== undefined && dto.ownerId !== existing.ownerId) {
      await this.prisma.ticketActivity.create({
        data: {
          workspaceId,
          ticketId: id,
          kind: "owner_changed",
          note: `${existing.ownerId ?? "—"} → ${dto.ownerId ?? "—"}`,
        },
      });
    }

    this.realtime.emitToWorkspace(workspaceId, "ticket.updated", { ticket: updated });

    if (
      typeof dto.ownerId === "string" &&
      dto.ownerId !== existing.ownerId &&
      dto.ownerId !== actorId
    ) {
      await this.notifyTicketOwner(workspaceId, dto.ownerId, id, updated.title, actorId);
    }

    if (
      typeof dto.ownerId === "string" &&
      dto.ownerId !== existing.ownerId &&
      existing.conversationId
    ) {
      const pl = await this.prisma.pipeline.findFirst({
        where: { id: existing.pipelineId, workspaceId },
        select: { assignsConversations: true },
      });
      if (pl?.assignsConversations) {
        await this.syncConversationOwner(workspaceId, existing.conversationId, dto.ownerId, actorId);
      }
    }

    return updated;
  }

  /** assignsConversations: the linked conversation follows the ticket owner. Bulk assign goes through updateTicket, so it is covered too. */
  private syncConversationOwner(workspaceId: string, conversationId: string, ownerId: string, actorId?: string) {
    return assignConversationToTicketOwner(
      { prisma: this.prisma, realtime: this.realtime, notifications: this.notifications },
      workspaceId,
      conversationId,
      ownerId,
      actorId,
    );
  }

  /** Best-effort: a notification problem must never fail the ticket write. */
  private async notifyTicketOwner(
    workspaceId: string,
    ownerId: string,
    ticketId: string,
    ticketTitle: string,
    actorId?: string,
  ): Promise<void> {
    if (!this.notifications) return;
    try {
      const actor = actorId
        ? await this.prisma.user.findUnique({ where: { id: actorId }, select: { name: true } })
        : null;
      await this.notifications.notify(workspaceId, [ownerId], {
        type: "assignment",
        title: "assignment.ticket",
        body: JSON.stringify({
          ticketTitle,
          ...(actor?.name ? { actorName: actor.name } : {}),
        }),
        recordKind: "ticket",
        recordId: ticketId,
        actorId,
      });
    } catch (err) {
      this.logger.warn(`owner notification failed: ${(err as Error)?.message}`);
    }
  }

  async moveTicket(
    workspaceId: string,
    id: string,
    dto: MoveTicketDto,
    viewer?: Viewer,
    /** Runs inside the same transaction as the move (e.g. the bulk "not a lead" contact flag). */
    opts?: {
      inTx?: (db: any) => Promise<unknown>;
      /** Only move if the ticket is still in this stage (409 tickets.undo_not_latest otherwise). */
      expectStageId?: string;
    },
  ) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, workspaceId },
      include: { stage: true, pipeline: { select: { agentCanMove: true, kind: true } } },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    await this.assertMoveAllowed(workspaceId, ticket.pipeline, viewer);
    if (opts?.expectStageId && ticket.stageId !== opts.expectStageId) {
      throw new ConflictException("tickets.undo_not_latest");
    }

    const targetStage = await this.prisma.ticketStage.findFirst({
      where: { id: dto.stageId, workspaceId },
    });
    if (!targetStage || targetStage.pipelineId !== ticket.pipelineId) {
      throw new BadRequestException("Target stage doesn't belong to ticket's pipeline");
    }
    if (targetStage.id === ticket.stageId) {
      // No-op
      return ticket;
    }

    const isLost = targetStage.isTerminal && !targetStage.isWon;
    // lostReasonId (SP-07) wins over free text; its label is the snapshot.
    let lostLabel: string | null = isLost ? (dto.lostReason ?? null) : null;
    let lostReasonId: string | null = null;
    if (isLost && dto.lostReasonId) {
      const reason = await this.prisma.lostReason.findFirst({
        where: { id: dto.lostReasonId, pipelineId: ticket.pipelineId, workspaceId, archivedAt: null },
        select: { id: true, label: true },
      });
      if (!reason) throw new BadRequestException("pipelines.invalid_lost_reason");
      lostReasonId = reason.id;
      lostLabel = reason.label;
    }
    if (isLost && !lostLabel) {
      throw new BadRequestException("lostReason is required when moving to a Lost stage");
    }

    const isLead = ticket.pipeline?.kind === "leads";
    const moveData = {
      stageId: targetStage.id,
      lostReason: isLost ? lostLabel : null,
      lostReasonId: isLost ? lostReasonId : null,
      closedAt: targetStage.isTerminal ? new Date() : null,
      enteredStageAt: new Date(),
    };
    const write = async (db: any) => {
      if (opts?.expectStageId) {
        // Conditional update: a concurrent move between our read and write wins.
        const res = await db.ticket.updateMany({ where: { id, workspaceId, stageId: opts.expectStageId }, data: moveData });
        if (res.count === 0) throw new ConflictException("tickets.undo_not_latest");
        return db.ticket.findFirst({ where: { id }, include: { contact: true, stage: true } });
      }
      return db.ticket.update({ where: { id }, data: moveData, include: { contact: true, stage: true } });
    };
    // Move + its activity + the lead lifecycle (or caller extra) commit together or not at all.
    const run = async (db: any) => {
      const row = await write(db);
      await db.ticketActivity.create({
        data: {
          workspaceId,
          ticketId: id,
          kind: targetStage.isTerminal ? (targetStage.isWon ? "won" : "lost") : "stage_changed",
          fromStage: ticket.stage.key,
          toStage: targetStage.key,
          note: dto.note ?? (isLost ? lostLabel : null),
          byUserId: dto.byUserId ?? null,
        },
      });
      if (isLead) await this.syncLeadLifecycle(db, workspaceId, id, ticket.contactId, ticket.stage, targetStage);
      if (opts?.inTx) await opts.inTx(db);
      return row;
    };
    // Dragging a closed lead back into an open stage reopens it: the one-open-card rule applies.
    const updated =
      isLead && ticket.stage.isTerminal && !targetStage.isTerminal
        ? await this.withLeadGuard(workspaceId, ticket.pipelineId, ticket.contactId, ticket.id, run)
        : isLead || opts?.inTx || opts?.expectStageId
          ? await this.prisma.$transaction((tx: any) => run(tx))
          : await run(this.prisma);

    // Broadcast to every other connected client in this workspace so their
    // pipeline boards reflect the move without a refetch. The author's own
    // socket also receives this — frontend handler is idempotent.
    this.realtime.emitToWorkspace(workspaceId, "ticket.moved", {
      ticket: updated,
      fromStageId: ticket.stageId,
      toStageId: targetStage.id,
    });

    this.events?.emit(WORKFLOW_TRIGGER_EVENT, {
      workspaceId,
      triggerType: "ticket_stage_changed",
      payload: { ticket: updated },
    } satisfies WorkflowTriggerEvent);

    return updated;
  }

  /**
   * SP-31: undo the latest stage move made from the inbox. Only the newest
   * move-type activity, within UNDO_WINDOW_MS, by its author (or a tickets.manage
   * holder), and only while the ticket is still in that toStage. The undo is a
   * normal moveTicket back (activity, realtime, workflow triggers, agentCanMove).
   */
  async undoLastMove(workspaceId: string, ticketId: string, viewer: Viewer) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: { stage: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    const latest = await this.prisma.ticketActivity.findFirst({
      where: { ticketId, workspaceId, kind: { in: ["stage_changed", "won", "lost"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const fromStage = latest?.fromStage
      ? await this.prisma.ticketStage.findFirst({
          where: { key: latest.fromStage, pipelineId: ticket.pipelineId, workspaceId },
        })
      : null;
    const canManage = this.perm ? await this.perm.viewerCan(workspaceId, viewer, "tickets.manage") : true;
    const refusal = undoRefusal({
      latest,
      ticketStageKey: ticket.stage.key,
      now: new Date(),
      userId: viewer?.userId,
      canManage,
      fromStageIsLost: !!fromStage?.isTerminal && !fromStage.isWon,
      fromStageExists: !!fromStage,
    });
    if (refusal === "tickets.undo_not_author") {
      throw new ForbiddenException({ statusCode: 403, message: refusal });
    }
    if (refusal) throw new ConflictException(refusal);
    if (!fromStage) throw new ConflictException("tickets.undo_not_allowed"); // unreachable: undoRefusal covers it
    return this.moveTicket(
      workspaceId,
      ticketId,
      { stageId: fromStage.id, note: UNDO_NOTE, byUserId: viewer?.userId },
      viewer,
      { expectStageId: ticket.stageId },
    );
  }

  /** SP-07: a pipeline can restrict moves to people who may edit pipelines
   *  (owner/admin). Internal callers pass no viewer and are never gated. */
  private async assertMoveAllowed(
    workspaceId: string,
    pipeline: { agentCanMove?: boolean } | null | undefined,
    viewer?: Viewer,
  ) {
    if (pipeline && pipeline.agentCanMove === false && viewer && this.perm) {
      if (!(await this.perm.viewerCan(workspaceId, viewer, "pipelines.update"))) {
        throw new ForbiddenException({ statusCode: 403, message: "Missing permission", permission: "pipelines.update" });
      }
    }
  }

  /**
   * SP-08 lead uniqueness: one open card per contact per leads pipeline.
   * Chosen approach: an interactive transaction that takes a transaction-scoped
   * Postgres advisory lock keyed on (pipeline, contact), re-checks for an open
   * card, then runs `fn` with the transaction client. Concurrent creates for
   * the same contact queue on the lock, so the loser's re-check sees the
   * winner's card and gets 409 (no serialization-failure retries). A partial
   * unique index can't express "pipeline.kind = leads", hence not used.
   * Callers retry P2002 (ticket number clash) around this whole call, since a
   * failed statement aborts the transaction.
   */
  private withLeadGuard<T>(
    workspaceId: string,
    pipelineId: string,
    contactId: string,
    excludeTicketId: string | undefined,
    fn: (db: any) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx: any) => {
      const key = `lead:${pipelineId}:${contactId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const existing = await tx.ticket.findFirst({
        where: {
          workspaceId,
          pipelineId,
          contactId,
          stage: { isTerminal: false },
          ...(excludeTicketId ? { id: { not: excludeTicketId } } : {}),
        },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException({ statusCode: 409, message: "tickets.lead_exists", ticketId: existing.id });
      }
      return fn(tx);
    });
  }

  /**
   * Leads pipelines tie the contact's lifecycle to the card: won -> customer;
   * lost -> unchanged. A marker activity records that THIS card made the
   * change, so leaving Won restores `lead` only when the contact is still
   * `customer` and this card set it.
   */
  private async syncLeadLifecycle(
    db: any,
    workspaceId: string,
    ticketId: string,
    contactId: string,
    from: { isTerminal: boolean; isWon: boolean },
    to: { isTerminal: boolean; isWon: boolean },
  ) {
    const wasWon = from.isTerminal && from.isWon;
    const isWon = to.isTerminal && to.isWon;
    if (isWon === wasWon) return;
    const contact = await db.contact.findFirst({
      where: { id: contactId, workspaceId },
      select: { lifecycle: true },
    });
    if (!contact) return;
    const current = (contact.lifecycle ?? "").toLowerCase();
    if (isWon) {
      if (current === "customer") return;
      await db.contact.update({ where: { id: contactId }, data: { lifecycle: "customer" } });
      await db.ticketActivity.create({
        data: { workspaceId, ticketId, kind: LIFECYCLE_ACTIVITY, note: `lifecycle:${current || "none"}->customer` },
      });
      return;
    }
    const marker = await db.ticketActivity.findFirst({
      where: { workspaceId, ticketId, kind: LIFECYCLE_ACTIVITY },
      orderBy: { createdAt: "desc" },
      select: { note: true },
    });
    if (!marker?.note?.endsWith("->customer") || current !== "customer") return;
    // Another won card in any leads pipeline still justifies "customer".
    const otherWon = await db.ticket.findFirst({
      where: {
        workspaceId,
        contactId,
        id: { not: ticketId },
        pipeline: { kind: "leads" },
        stage: { isTerminal: true, isWon: true },
      },
      select: { id: true },
    });
    if (otherWon) return;
    await db.contact.update({ where: { id: contactId }, data: { lifecycle: "lead" } });
    await db.ticketActivity.create({
      data: { workspaceId, ticketId, kind: LIFECYCLE_ACTIVITY, note: "lifecycle:customer->lead" },
    });
  }

  /**
   * Returns a closed ticket to the open stage it was in before closing (read
   * from its latest won/lost activity, else its last stage_changed target;
   * first open stage if that stage no longer exists), clearing closedAt and
   * the lost reason.
   */
  async reopenTicket(workspaceId: string, id: string, viewer?: Viewer, actorId?: string) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, workspaceId },
      include: { stage: true, pipeline: { select: { agentCanMove: true, kind: true, archivedAt: true } } },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    if (!ticket.stage.isTerminal && !ticket.closedAt) throw new BadRequestException("tickets.not_closed");
    if (ticket.pipeline?.archivedAt) throw new BadRequestException("pipelines.archived");
    await this.assertMoveAllowed(workspaceId, ticket.pipeline, viewer);

    const openStageByKey = (key: string) =>
      this.prisma.ticketStage.findFirst({
        where: { workspaceId, pipelineId: ticket.pipelineId, key, isTerminal: false },
      });
    const closing = await this.prisma.ticketActivity.findFirst({
      where: { workspaceId, ticketId: id, kind: { in: ["won", "lost"] } },
      orderBy: { createdAt: "desc" },
      select: { fromStage: true },
    });
    let target = closing?.fromStage ? await openStageByKey(closing.fromStage) : null;
    if (!target) {
      const last = await this.prisma.ticketActivity.findFirst({
        where: { workspaceId, ticketId: id, kind: "stage_changed" },
        orderBy: { createdAt: "desc" },
        select: { toStage: true },
      });
      if (last?.toStage) target = await openStageByKey(last.toStage);
    }
    if (!target) {
      target = await this.prisma.ticketStage.findFirst({
        where: { workspaceId, pipelineId: ticket.pipelineId, isTerminal: false },
        orderBy: { order: "asc" },
      });
    }
    if (!target) throw new BadRequestException("Pipeline has no open stage");
    const stage = target;

    const isLead = ticket.pipeline?.kind === "leads";
    const write = async (db: any) => {
      const row = await db.ticket.update({
        where: { id },
        data: { stageId: stage.id, closedAt: null, lostReason: null, lostReasonId: null, enteredStageAt: new Date() },
        include: { contact: true, stage: true },
      });
      await db.ticketActivity.create({
        data: {
          workspaceId,
          ticketId: id,
          kind: "reopened",
          fromStage: ticket.stage.key,
          toStage: stage.key,
          byUserId: actorId ?? null,
        },
      });
      if (isLead) await this.syncLeadLifecycle(db, workspaceId, id, ticket.contactId, ticket.stage, stage);
      return row;
    };
    const updated = isLead
      ? await this.withLeadGuard(workspaceId, ticket.pipelineId, ticket.contactId, id, write)
      : await write(this.prisma);

    this.realtime.emitToWorkspace(workspaceId, "ticket.moved", {
      ticket: updated,
      fromStageId: ticket.stageId,
      toStageId: stage.id,
    });
    this.events?.emit(WORKFLOW_TRIGGER_EVENT, {
      workspaceId,
      triggerType: "ticket_stage_changed",
      payload: { ticket: updated },
    } satisfies WorkflowTriggerEvent);
    return updated;
  }

  async createFromConversation(
    workspaceId: string,
    conversationId: string,
    dto: {
      pipelineId: string;
      stageId: string;
      title: string;
      description?: string;
      value?: number;
      ownerId?: string;
      priority?: string;
      category?: string | null;
    },
    actorId?: string,
  ) {
    assertTicketFields(dto);
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
    });
    if (!conv) throw new NotFoundException("Conversation not found");

    return this.createTicket(
      workspaceId,
      {
        pipelineId: dto.pipelineId,
        stageId: dto.stageId,
        contactId: conv.contactId,
        conversationId,
        title: dto.title,
        description: dto.description,
        value: dto.value,
        ownerId: dto.ownerId,
        priority: dto.priority,
        category: dto.category,
      },
      actorId,
    );
  }

  /**
   * SP-09 resolve: a normal move (activity, lead lifecycle, realtime and
   * workflow triggers unchanged) to the pipeline's won terminal stage with the
   * lowest order, with the note as the move's activity note (kind `won`).
   * 409 tickets.already_closed for a ticket in a terminal stage; 409
   * tickets.no_resolved_stage when the pipeline has no won terminal stage.
   * Never messages the customer. Returns the ticket DTO.
   */
  async resolveTicket(workspaceId: string, id: string, dto: ResolveTicketDto, viewer?: Viewer) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, workspaceId },
      include: { stage: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    if (ticket.stage.isTerminal) throw ticketError("tickets.already_closed");
    const target = await this.prisma.ticketStage.findFirst({
      where: { workspaceId, pipelineId: ticket.pipelineId, isTerminal: true, isWon: true },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    });
    if (!target) throw ticketError("tickets.no_resolved_stage");
    const note = dto.note?.trim();
    const move = { stageId: target.id, ...(note ? { note } : {}), ...(viewer ? { byUserId: viewer.userId } : {}) };
    const isRace = (e: unknown) => e instanceof ConflictException && e.message === "tickets.undo_not_latest";
    // expectStageId (review M1): the move is a conditional write on the stage
    // read above, so a concurrent change is a conflict, never a silent
    // Lost -> Won flip. On a conflict (final review M3) re-read the ticket:
    // closed meanwhile -> 409 already_closed; moved to another open stage ->
    // retry once from there; moved again during the retry -> 409 stage_changed.
    let expectStageId = ticket.stageId;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.moveTicket(workspaceId, id, move, viewer, { expectStageId });
        break;
      } catch (e) {
        if (!isRace(e)) throw e;
        const now = await this.prisma.ticket.findFirst({
          where: { id, workspaceId },
          include: { stage: true },
        });
        if (!now) throw new NotFoundException("Ticket not found");
        if (now.stage.isTerminal) throw ticketError("tickets.already_closed");
        if (attempt >= 1) throw ticketError("tickets.stage_changed");
        expectStageId = now.stageId;
      }
    }
    return this.getTicket(workspaceId, id, viewer);
  }

  /**
   * SP-09 booking cards (ruling 7): the ticket contact's pending and
   * confirmed bookings from one day back, soonest first, at most
   * TICKET_BOOKINGS_MAX. The route needs bookings.view (guard); the ticket
   * itself needs tickets.view. A foreign ticket id is 404.
   */
  async bookingsForTicket(workspaceId: string, id: string, viewer?: Viewer): Promise<{ items: TicketBookingCardDto[] }> {
    if (this.perm && !(await this.perm.viewerCan(workspaceId, viewer, "tickets.view"))) {
      throw new ForbiddenException({ statusCode: 403, message: "Missing permission", permission: "tickets.view" });
    }
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, workspaceId },
      select: { contactId: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    const items = await this.prisma.appointment.findMany({
      where: {
        workspaceId,
        contactId: ticket.contactId,
        status: { in: ["pending", "confirmed"] },
        startAt: { gte: new Date(Date.now() - TICKET_BOOKINGS_LOOKBACK_MS) },
      },
      orderBy: [{ startAt: "asc" }, { id: "asc" }],
      take: TICKET_BOOKINGS_MAX,
      select: {
        id: true,
        startAt: true,
        durationMin: true,
        status: true,
        service: true,
        serviceAr: true,
        staffId: true,
        source: true,
        hjzSyncError: true,
      },
    });
    return { items };
  }

  async addNote(workspaceId: string, id: string, dto: AddNoteDto) {
    const ticket = await this.findTicket(workspaceId, id);
    const activity = await this.prisma.ticketActivity.create({
      data: {
        workspaceId,
        ticketId: id,
        kind: "note",
        note: dto.note,
        byUserId: dto.byUserId ?? null,
      },
    });
    this.realtime.emitToWorkspace(workspaceId, "ticket.updated", { ticket });
    return activity;
  }

  async deleteTicket(workspaceId: string, id: string) {
    await this.findTicket(workspaceId, id);
    await this.prisma.ticket.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Dashboard summary ─────────────────────────────────────────────────
  async dashboardSummary(workspaceId: string, pipelineId?: string) {
    const all = await this.prisma.ticket.findMany({
      where: { workspaceId, ...(pipelineId ? { pipelineId } : {}) },
      include: { stage: true },
    });

    let openValue = 0;
    let wonCount = 0;
    let lostCount = 0;
    let totalCloseMinutes = 0;
    let closedCount = 0;

    for (const t of all) {
      const isTerminal = t.stage.isTerminal;
      if (!isTerminal) {
        openValue += t.value ?? 0;
      } else {
        if (t.stage.isWon) wonCount++;
        else lostCount++;
        if (t.closedAt) {
          const ms = t.closedAt.getTime() - t.createdAt.getTime();
          totalCloseMinutes += ms / 60_000;
          closedCount++;
        }
      }
    }

    const winRate = wonCount + lostCount > 0
      ? Math.round((wonCount / (wonCount + lostCount)) * 100)
      : 0;
    const avgCloseHours = closedCount > 0
      ? Math.round((totalCloseMinutes / closedCount / 60) * 10) / 10
      : 0;

    return {
      openValue,
      currency: "SAR",
      winRate,
      wonCount,
      lostCount,
      avgCloseHours,
      totalTickets: all.length,
    };
  }
}
