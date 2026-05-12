import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { NotesService } from "./notes.service";
import { CreateNoteDto, UpdateNoteDto } from "./notes.dto";
import type { JwtPayload } from "../auth/auth.guard";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("notes")
export class NotesController {
  constructor(private readonly svc: NotesService) {}

  @Get()
  list(
    @CurrentWorkspace() workspaceId: string,
    @Query("contactId") contactId?: string,
    @Query("conversationId") conversationId?: string,
    @Query("ticketId") ticketId?: string,
  ) {
    if (ticketId) return this.svc.listForTicket(workspaceId, ticketId);
    if (conversationId) return this.svc.listForConversation(workspaceId, conversationId);
    if (contactId) return this.svc.listForContact(workspaceId, contactId);
    return [];
  }

  @Post()
  create(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: CreateNoteDto,
    @Req() req: Request & { user?: JwtPayload },
  ) {
    return this.svc.create(workspaceId, dto, req.user?.sub ?? null);
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateNoteDto,
  ) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.remove(workspaceId, id);
  }
}
