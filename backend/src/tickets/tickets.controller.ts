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
import { TicketsService } from "./tickets.service";
import {
  AddNoteDto,
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
    @Optional() private readonly perm?: PermissionService,
  ) {}

  // ── Pipelines ──────────────────────────────────────────────────────────
  @Get("pipelines")
  listPipelines(@CurrentWorkspace() workspaceId: string) {
    return this.svc.listPipelines(workspaceId);
  }

  @Get("pipelines/:id")
  getPipeline(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.getPipeline(workspaceId, id);
  }

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

  @Get("tickets/:id")
  getTicket(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.getTicket(workspaceId, id);
  }

  @Post("tickets")
  createTicket(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Body() dto: CreateTicketDto,
  ) {
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
  ) {
    return this.svc.moveTicket(workspaceId, id, dto);
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
