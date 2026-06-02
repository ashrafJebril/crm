import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import {
  AddNoteDto,
  CreateTicketDto,
  ListTicketsQuery,
  MoveTicketDto,
  UpdateTicketDto,
} from "./tickets.dto";

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  // ─── Pipelines ─────────────────────────────────────────────────────────
  async listPipelines(workspaceId: string) {
    return this.prisma.pipeline.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      include: {
        stages: { orderBy: { order: "asc" } },
        _count: { select: { tickets: true } },
      },
    });
  }

  async getPipeline(workspaceId: string, id: string) {
    const p = await this.prisma.pipeline.findFirst({
      where: { id, workspaceId },
      include: { stages: { orderBy: { order: "asc" } } },
    });
    if (!p) throw new NotFoundException("Pipeline not found");
    return p;
  }

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

  async createTicket(workspaceId: string, dto: CreateTicketDto) {
    // Validate pipeline and stage and that the stage belongs to the pipeline.
    const stage = await this.prisma.ticketStage.findFirst({
      where: { id: dto.stageId, workspaceId },
    });
    if (!stage || stage.pipelineId !== dto.pipelineId) {
      throw new BadRequestException("stageId does not belong to pipelineId");
    }

    // Per-pipeline, per-workspace auto-incrementing number
    const lastInPipeline = await this.prisma.ticket.findFirst({
      where: { pipelineId: dto.pipelineId, workspaceId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (lastInPipeline?.number ?? 0) + 1;

    const ticket = await this.prisma.ticket.create({
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

    await this.prisma.ticketActivity.create({
      data: {
        workspaceId,
        ticketId: ticket.id,
        kind: "created",
        toStage: stage.key,
      },
    });

    return ticket;
  }

  async updateTicket(workspaceId: string, id: string, dto: UpdateTicketDto) {
    const existing = await this.prisma.ticket.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException("Ticket not found");

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

    return updated;
  }

  async moveTicket(workspaceId: string, id: string, dto: MoveTicketDto) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, workspaceId },
      include: { stage: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

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
    if (isLost && !dto.lostReason) {
      throw new BadRequestException("lostReason is required when moving to a Lost stage");
    }

    const updated = await this.prisma.ticket.update({
      where: { id },
      data: {
        stageId: targetStage.id,
        lostReason: isLost ? dto.lostReason : null,
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
        note: dto.note ?? (isLost ? dto.lostReason : null),
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

    return updated;
  }

  async addNote(workspaceId: string, id: string, dto: AddNoteDto) {
    await this.getTicket(workspaceId, id);
    return this.prisma.ticketActivity.create({
      data: {
        workspaceId,
        ticketId: id,
        kind: "note",
        note: dto.note,
        byUserId: dto.byUserId ?? null,
      },
    });
  }

  async deleteTicket(workspaceId: string, id: string) {
    await this.getTicket(workspaceId, id);
    await this.prisma.ticket.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Dashboard summary ─────────────────────────────────────────────────
  async dashboardSummary(workspaceId: string) {
    const all = await this.prisma.ticket.findMany({
      where: { workspaceId },
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
