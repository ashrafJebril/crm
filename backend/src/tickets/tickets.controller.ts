import {
  Body,
  Controller,
  Delete,
  Get,
  Optional,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { stripReservedMarker } from "./undo-stage";
import { TicketsService } from "./tickets.service";
import { TicketsBulkService } from "./tickets-bulk.service";
import {
  AddNoteDto,
  BulkTicketsDto,
  CreateFromConversationDto,
  CreateTicketDto,
  ListTicketsQuery,
  MoveTicketDto,
  UpdateTicketDto,
} from "./tickets.dto";
import { CurrentUserId, CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";

@Controller()
export class TicketsController {
  constructor(
    private readonly svc: TicketsService,
    private readonly bulkSvc: TicketsBulkService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  // Pipelines moved to PipelinesController (SP-07).

  // ── Tickets ────────────────────────────────────────────────────────────
  @Get("tickets")
  listTickets(@CurrentWorkspace() workspaceId: string, @Query() query: ListTicketsQuery) {
    return this.svc.listTickets(workspaceId, query);
  }

  @Get("tickets/dashboard/summary")
  dashboardSummary(
    @CurrentWorkspace() workspaceId: string,
    @Query("pipelineId") pipelineId?: string,
  ) {
    return this.svc.dashboardSummary(workspaceId, pipelineId);
  }

  /** Bulk assign / lost / not-a-lead (SP-08). */
  @Post("tickets/bulk")
  bulk(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Body() dto: BulkTicketsDto,
    @CurrentViewer() viewer?: Viewer,
  ) {
    return this.bulkSvc.run(workspaceId, dto, viewer, userId);
  }

  @Get("tickets/:id")
  getTicket(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.getTicket(workspaceId, id);
  }

  @Post("tickets")
  async createTicket(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Body() dto: CreateTicketDto,
    @CurrentViewer() viewer?: Viewer,
  ) {
    // A hidden conversation cannot be linked: 404, same as reading it.
    if (dto.conversationId) {
      await this.perm?.assertConversationVisible(workspaceId, dto.conversationId, viewer);
    }
    return this.svc.createTicket(workspaceId, dto, userId);
  }

  @Post("tickets/from-conversation/:conversationId")
  async createFromConversation(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("conversationId") conversationId: string,
    @Body() dto: CreateFromConversationDto,
    @CurrentViewer() viewer?: Viewer,
  ) {
    // Hidden conversation -> 404, not a ticket seeded from it.
    await this.perm?.assertConversationVisible(workspaceId, conversationId, viewer);
    return this.svc.createFromConversation(workspaceId, conversationId, dto, userId);
  }

  @Patch("tickets/:id")
  updateTicket(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body() dto: UpdateTicketDto,
  ) {
    return this.svc.updateTicket(workspaceId, id, dto, userId);
  }

  @Post("tickets/:id/move")
  moveTicket(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: MoveTicketDto,
    @CurrentViewer() viewer?: Viewer,
  ) {
    // The mover is the authenticated member (a client-supplied byUserId is not
    // trusted): the activity's author drives who may undo the move (SP-31).
    const safe = { ...dto, note: stripReservedMarker(dto.note) };
    return this.svc.moveTicket(workspaceId, id, viewer ? { ...safe, byUserId: viewer.userId } : safe, viewer);
  }

  /** SP-31: undo the latest stage move (10-minute window, author or manager). */
  @Post("tickets/:id/undo-stage")
  undoStage(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.undoLastMove(workspaceId, id, viewer);
  }

  @Post("tickets/:id/reopen")
  reopen(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @CurrentViewer() viewer?: Viewer,
  ) {
    return this.svc.reopenTicket(workspaceId, id, viewer, userId);
  }

  @Post("tickets/:id/notes")
  addNote(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: AddNoteDto,
  ) {
    return this.svc.addNote(workspaceId, id, dto);
  }

  @Delete("tickets/:id")
  deleteTicket(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.deleteTicket(workspaceId, id);
  }
}
