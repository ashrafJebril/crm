import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { TicketsService } from "./tickets.service";
import {
  AddNoteDto,
  CreateTicketDto,
  ListTicketsQuery,
  MoveTicketDto,
  UpdateTicketDto,
} from "./tickets.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller()
export class TicketsController {
  constructor(private readonly svc: TicketsService) {}

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
  dashboardSummary(@CurrentWorkspace() workspaceId: string) {
    return this.svc.dashboardSummary(workspaceId);
  }

  @Get("tickets/:id")
  getTicket(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.getTicket(workspaceId, id);
  }

  @Post("tickets")
  createTicket(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateTicketDto) {
    return this.svc.createTicket(workspaceId, dto);
  }

  @Patch("tickets/:id")
  updateTicket(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateTicketDto,
  ) {
    return this.svc.updateTicket(workspaceId, id, dto);
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
