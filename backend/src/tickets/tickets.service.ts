import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  AddNoteDto,
  CreateTicketDto,
  ListTicketsQuery,
  MoveTicketDto,
  UpdateTicketDto,
} from "./tickets.dto";

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Pipelines ─────────────────────────────────────────────────────────
  async listPipelines() {
    return this.prisma.pipeline.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        stages: { orderBy: { order: "asc" } },
        _count: { select: { tickets: true } },
      },
    });
  }

  async getPipeline(id: string) {
    const p = await this.prisma.pipeline.findUnique({
      where: { id },
      include: { stages: { orderBy: { order: "asc" } } },
    });
    if (!p) throw new NotFoundException("Pipeline not found");
    return p;
  }

  // ─── Tickets ───────────────────────────────────────────────────────────
  async listTickets(query: ListTicketsQuery) {
    return this.prisma.ticket.findMany({
      where: {
        pipelineId: query.pipelineId,
        stageId: query.stageId,
        contactId: query.contactId,
        ownerId: query.ownerId,
      },
      orderBy: [{ stageId: "asc" }, { updatedAt: "desc" }],
      take: query.limit,
      include: {
        contact: true,
        stage: true,
      },
    });
  }

  async getTicket(id: string) {
    const t = await this.prisma.ticket.findUnique({
      where: { id },
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

  async createTicket(dto: CreateTicketDto) {
    // Validate pipeline and stage and that the stage belongs to the pipeline.
    const stage = await this.prisma.ticketStage.findUnique({
      where: { id: dto.stageId },
    });
    if (!stage || stage.pipelineId !== dto.pipelineId) {
      throw new BadRequestException("stageId does not belong to pipelineId");
    }

    // Per-pipeline auto-incrementing number
    const lastInPipeline = await this.prisma.ticket.findFirst({
      where: { pipelineId: dto.pipelineId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (lastInPipeline?.number ?? 0) + 1;

    const ticket = await this.prisma.ticket.create({
      data: {
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
        ticketId: ticket.id,
        kind: "created",
        toStage: stage.key,
      },
    });

    return ticket;
  }

  async updateTicket(id: string, dto: UpdateTicketDto) {
    const existing = await this.prisma.ticket.findUnique({ where: { id } });
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
          ticketId: id,
          kind: "value_changed",
          note: `${existing.value ?? 0} → ${dto.value}`,
        },
      });
    }
    if (dto.ownerId !== undefined && dto.ownerId !== existing.ownerId) {
      await this.prisma.ticketActivity.create({
        data: {
          ticketId: id,
          kind: "owner_changed",
          note: `${existing.ownerId ?? "—"} → ${dto.ownerId ?? "—"}`,
        },
      });
    }

    return updated;
  }

  async moveTicket(id: string, dto: MoveTicketDto) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: { stage: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const targetStage = await this.prisma.ticketStage.findUnique({
      where: { id: dto.stageId },
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
        ticketId: id,
        kind: targetStage.isTerminal ? (targetStage.isWon ? "won" : "lost") : "stage_changed",
        fromStage: ticket.stage.key,
        toStage: targetStage.key,
        note: dto.note ?? (isLost ? dto.lostReason : null),
        byUserId: dto.byUserId ?? null,
      },
    });

    return updated;
  }

  async addNote(id: string, dto: AddNoteDto) {
    await this.getTicket(id);
    return this.prisma.ticketActivity.create({
      data: {
        ticketId: id,
        kind: "note",
        note: dto.note,
        byUserId: dto.byUserId ?? null,
      },
    });
  }

  async deleteTicket(id: string) {
    await this.getTicket(id);
    await this.prisma.ticket.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Dashboard summary ─────────────────────────────────────────────────
  async dashboardSummary() {
    const all = await this.prisma.ticket.findMany({
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
