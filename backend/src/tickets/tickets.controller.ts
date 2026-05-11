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

@Controller()
export class TicketsController {
  constructor(private readonly svc: TicketsService) {}

  // ── Pipelines ──────────────────────────────────────────────────────────
  @Get("pipelines")
  listPipelines() {
    return this.svc.listPipelines();
  }

  @Get("pipelines/:id")
  getPipeline(@Param("id") id: string) {
    return this.svc.getPipeline(id);
  }

  // ── Tickets ────────────────────────────────────────────────────────────
  @Get("tickets")
  listTickets(@Query() query: ListTicketsQuery) {
    return this.svc.listTickets(query);
  }

  @Get("tickets/dashboard/summary")
  dashboardSummary() {
    return this.svc.dashboardSummary();
  }

  @Get("tickets/:id")
  getTicket(@Param("id") id: string) {
    return this.svc.getTicket(id);
  }

  @Post("tickets")
  createTicket(@Body() dto: CreateTicketDto) {
    return this.svc.createTicket(dto);
  }

  @Patch("tickets/:id")
  updateTicket(@Param("id") id: string, @Body() dto: UpdateTicketDto) {
    return this.svc.updateTicket(id, dto);
  }

  @Post("tickets/:id/move")
  moveTicket(@Param("id") id: string, @Body() dto: MoveTicketDto) {
    return this.svc.moveTicket(id, dto);
  }

  @Post("tickets/:id/notes")
  addNote(@Param("id") id: string, @Body() dto: AddNoteDto) {
    return this.svc.addNote(id, dto);
  }

  @Delete("tickets/:id")
  deleteTicket(@Param("id") id: string) {
    return this.svc.deleteTicket(id);
  }
}
