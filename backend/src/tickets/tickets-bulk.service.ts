import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { TicketsService } from "./tickets.service";
import { BulkTicketsDto, TICKET_BULK_CAP, TICKET_BULK_OPS } from "./tickets.dto";

/** Lost-reason snapshot written by "Not a lead" (EN and AR in one label). */
export const NOT_A_LEAD_REASON = "Not a lead — ليس عميلاً محتملاً";

export interface TicketsBulkResult {
  affected: number;
  /** Ids the action did not apply to (closed, wrong pipeline, gated, not a lead...). */
  skipped: string[];
}

/**
 * Bulk assign / lost / not-a-lead over selected cards (SP-08). The route needs
 * tickets.update (permission map); every row is then checked on its own:
 * workspace membership (foreign ids -> 404 for the whole request) and the
 * per-row gates (agentCanMove via TicketsService.moveTicket, archived
 * pipelines, closed cards). Rows that fail a gate are skipped, not fatal.
 */
@Injectable()
export class TicketsBulkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  async run(workspaceId: string, dto: BulkTicketsDto, viewer?: Viewer, actorId?: string): Promise<TicketsBulkResult> {
    if (!TICKET_BULK_OPS.includes(dto.op)) throw new BadRequestException("Unknown bulk op");
    if (!Array.isArray(dto.ids) || dto.ids.length === 0) throw new BadRequestException("ids required");
    if (dto.ids.length > TICKET_BULK_CAP) {
      throw new BadRequestException(`At most ${TICKET_BULK_CAP} tickets per bulk action`);
    }
    const ids = [...new Set(dto.ids)];

    const rows = await this.prisma.ticket.findMany({
      where: { workspaceId, id: { in: ids } },
      include: {
        stage: { select: { isTerminal: true, isWon: true } },
        pipeline: { select: { id: true, kind: true, agentCanMove: true, archivedAt: true } },
      },
    });
    if (rows.length !== ids.length) throw new NotFoundException("One or more tickets not found in this workspace");

    // Order-preserving, so results are deterministic.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.map((id) => byId.get(id)!);

    switch (dto.op) {
      case "assign":
        return this.assign(workspaceId, ordered, dto, actorId);
      case "lost":
        return this.lost(workspaceId, ordered, dto, viewer, actorId);
      case "notALead":
        return this.notALead(workspaceId, ordered, viewer, actorId);
    }
  }

  private async assign(workspaceId: string, rows: Row[], dto: BulkTicketsDto, actorId?: string) {
    if (dto.ownerId === undefined) throw new BadRequestException("ownerId required (or null to unassign)");
    if (dto.ownerId !== null) {
      const member = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, userId: dto.ownerId } });
      if (!member) throw new BadRequestException("owner is not a member");
    }
    return this.each(rows, async (r) => {
      await this.tickets.updateTicket(workspaceId, r.id, { ownerId: dto.ownerId as string }, actorId);
      return true;
    });
  }

  private async lost(workspaceId: string, rows: Row[], dto: BulkTicketsDto, viewer?: Viewer, actorId?: string) {
    if (!dto.lostReasonId) throw new BadRequestException("lostReasonId required");
    const reason = await this.prisma.lostReason.findFirst({
      where: { id: dto.lostReasonId, workspaceId, archivedAt: null },
      select: { id: true, pipelineId: true },
    });
    if (!reason) throw new NotFoundException("Lost reason not found");
    return this.each(rows, async (r) => {
      // A reason belongs to one pipeline; rows of other pipelines can't use it.
      if (isClosed(r) || r.pipeline?.archivedAt || r.pipelineId !== reason.pipelineId) return false;
      const stage = await this.lostStage(workspaceId, r.pipelineId);
      if (!stage) return false;
      await this.tickets.moveTicket(workspaceId, r.id, { stageId: stage.id, lostReasonId: reason.id, byUserId: actorId }, viewer);
      return true;
    });
  }

  private async notALead(workspaceId: string, rows: Row[], viewer?: Viewer, actorId?: string) {
    // Flags the contact, so contacts.update is needed on top of the route's tickets.update.
    if (this.perm && !(await this.perm.viewerCan(workspaceId, viewer, "contacts.update"))) {
      throw new ForbiddenException({ statusCode: 403, message: "Missing permission", permission: "contacts.update" });
    }
    return this.each(rows, async (r) => {
      if (r.pipeline?.kind !== "leads" || isClosed(r) || r.pipeline?.archivedAt) return false;
      const stage = await this.lostStage(workspaceId, r.pipelineId);
      if (!stage) return false;
      // Close first: if the move is gated, the contact must not be flagged.
      await this.tickets.moveTicket(
        workspaceId,
        r.id,
        { stageId: stage.id, lostReason: NOT_A_LEAD_REASON, byUserId: actorId },
        viewer,
      );
      await this.prisma.contact.updateMany({
        where: { workspaceId, id: { in: [r.contactId] } },
        data: { notALead: true },
      });
      return true;
    });
  }

  private lostStage(workspaceId: string, pipelineId: string) {
    return this.prisma.ticketStage.findFirst({
      where: { workspaceId, pipelineId, isTerminal: true, isWon: false },
      orderBy: { order: "asc" },
      select: { id: true },
    });
  }

  /** Sequentially (ticket events, per-pipeline state): applied rows count; refusals are skipped. */
  private async each(rows: Row[], apply: (r: Row) => Promise<boolean>): Promise<TicketsBulkResult> {
    let affected = 0;
    const skipped: string[] = [];
    for (const r of rows) {
      try {
        if (await apply(r)) affected += 1;
        else skipped.push(r.id);
      } catch (e) {
        // A per-row refusal (403 gate, 400 invalid state, 409) skips the row; anything else is a real failure.
        if (e instanceof HttpException) skipped.push(r.id);
        else throw e;
      }
    }
    return { affected, skipped };
  }
}

type Row = {
  id: string;
  pipelineId: string;
  contactId: string;
  closedAt: Date | null;
  stage: { isTerminal: boolean; isWon: boolean };
  pipeline: { id: string; kind: string; agentCanMove: boolean; archivedAt: Date | null } | null;
};

const isClosed = (r: Row) => !!r.closedAt || r.stage.isTerminal;
