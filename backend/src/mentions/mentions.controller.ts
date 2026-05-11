import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { MentionsService } from "./mentions.service";
import { OpenTicketService } from "./open-ticket.service";
import { ListMentionsQuery, UpdateMentionDto } from "./mentions.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("mentions")
export class MentionsController {
  constructor(
    private readonly svc: MentionsService,
    private readonly tickets: OpenTicketService,
  ) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string, @Query() q: ListMentionsQuery) {
    return this.svc.list(workspaceId, q);
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.get(workspaceId, id);
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateMentionDto,
  ) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Post(":id/open-ticket")
  openTicket(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.tickets.fromMention(workspaceId, id);
  }
}
