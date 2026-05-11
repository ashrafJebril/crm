import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { MentionsService } from "./mentions.service";
import { OpenTicketService } from "./open-ticket.service";
import { ListMentionsQuery, UpdateMentionDto } from "./mentions.dto";

@Controller("mentions")
export class MentionsController {
  constructor(
    private readonly svc: MentionsService,
    private readonly tickets: OpenTicketService,
  ) {}

  @Get()
  list(@Query() q: ListMentionsQuery) {
    return this.svc.list(q);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.svc.get(id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateMentionDto) {
    return this.svc.update(id, dto);
  }

  @Post(":id/open-ticket")
  openTicket(@Param("id") id: string) {
    return this.tickets.fromMention(id);
  }
}
