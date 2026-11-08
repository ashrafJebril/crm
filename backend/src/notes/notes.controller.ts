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
import type { Viewer } from "../permissions/visibility";
import { NotesService } from "./notes.service";
import { CreateNoteDto, UpdateNoteDto } from "./notes.dto";
import type { JwtPayload } from "../auth/auth.guard";
import { CurrentUserId, CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("notes")
export class NotesController {
  constructor(private readonly svc: NotesService) {}

  @Get()
  list(
    @CurrentWorkspace() workspaceId: string,
    @Query("contactId") contactId?: string,
    @Query("conversationId") conversationId?: string,
    @Query("ticketId") ticketId?: string,
    @CurrentViewer() viewer?: Viewer,
  ) {
    if (ticketId) return this.svc.listForTicket(workspaceId, ticketId);
    if (conversationId) return this.svc.listForConversation(workspaceId, conversationId, viewer);
    if (contactId) return this.svc.listForContact(workspaceId, contactId);
    return [];
  }

  @Post()
  create(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: CreateNoteDto,
    @Req() req: Request & { user?: JwtPayload },
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.create(workspaceId, dto, req.user?.sub ?? null, viewer);
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateNoteDto,
    @CurrentUserId() userId: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.update(workspaceId, id, dto, userId, viewer);
  }

  @Post(":id/seen")
  seen(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @CurrentUserId() userId: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.markSeen(workspaceId, id, userId, viewer);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @CurrentViewer() viewer: Viewer) {
    return this.svc.remove(workspaceId, id, viewer);
  }
}
