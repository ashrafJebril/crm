import {
  BadRequestException,
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
  UpdateTicketDto,
} from "./tickets.dto";
import { WORKFLOW_TRIGGER_EVENT, WorkflowTriggerEvent } from "../workflows/workflow-events";

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
  async listTickets(workspaceId: string, query: ListTicketsQuery) {
    const take = query.limit ?? 50;
    const items = await this.prisma.ticket.findMany({
      where: {
        workspaceId,
        pipelineId: query.pipelineId,
        stageId: query.stageId,
        contactId: query.contactId,
        conversationId: query.conversationId,
        ownerId: query.ownerId,
      },
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
      items: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async getTicket(workspaceId: string, id: string) {
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
      select: { archivedAt: true },
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
    let ticket: Prisma.PromiseReturnType<typeof this.prisma.ticket.create> | null =
      null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const lastInPipeline = await this.prisma.ticket.findFirst({
        where: { pipelineId: dto.pipelineId, workspaceId },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      const number = (lastInPipeline?.number ?? 0) + 1;
      try {
        ticket = await this.prisma.ticket.create({
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
          },
          include: { contact: true, stage: true },
        });
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

    // A reassigned owner must be a member of this workspace.
    await this.assertTicketRefs(workspaceId, { ownerId: dto.ownerId });

    const updated = await this.prisma.ticket.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        value: dto.value,
        ownerId: dto.ownerId,
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

    return updated;
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

  async moveTicket(workspaceId: string, id: string, dto: MoveTicketDto, viewer?: Viewer) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, workspaceId },
      include: { stage: true, pipeline: { select: { agentCanMove: true } } },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    // SP-07: a pipeline can restrict moves to people who may edit pipelines
    // (owner/admin). Internal callers pass no viewer and are never gated.
    if (ticket.pipeline && ticket.pipeline.agentCanMove === false && viewer && this.perm) {
      if (!(await this.perm.viewerCan(workspaceId, viewer, "pipelines.update"))) {
        throw new ForbiddenException({ statusCode: 403, message: "Missing permission", permission: "pipelines.update" });
      }
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

    const updated = await this.prisma.ticket.update({
      where: { id },
      data: {
        stageId: targetStage.id,
        lostReason: isLost ? lostLabel : null,
        lostReasonId: isLost ? lostReasonId : null,
        closedAt: targetStage.isTerminal ? new Date() : null,
        enteredStageAt: new Date(),
      },
      include: { contact: true, stage: true },
    });

    await this.prisma.ticketActivity.create({
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
    },
    actorId?: string,
  ) {
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
      },
      actorId,
    );
  }

  async addNote(workspaceId: string, id: string, dto: AddNoteDto) {
    const ticket = await this.getTicket(workspaceId, id);
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
    await this.getTicket(workspaceId, id);
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
