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

@Controller("notes")
export class NotesController {
  constructor(private readonly svc: NotesService) {}

  @Get()
  list(
    @Query("contactId") contactId?: string,
    @Query("conversationId") conversationId?: string,
  ) {
    if (conversationId) return this.svc.listForConversation(conversationId);
    if (contactId) return this.svc.listForContact(contactId);
    return [];
  }

  @Post()
  create(
    @Body() dto: CreateNoteDto,
    @Req() req: Request & { user?: JwtPayload },
  ) {
    return this.svc.create(dto, req.user?.sub ?? null);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateNoteDto) {
    return this.svc.update(id, dto);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.svc.remove(id);
  }
}
