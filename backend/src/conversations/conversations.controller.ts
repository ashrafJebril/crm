import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ConversationsService } from "./conversations.service";
import {
  CreateConversationDto,
  CreateMessageDto,
  UpdateConversationDto,
} from "./conversations.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly svc: ConversationsService) {}

  @Get() list(@CurrentWorkspace() workspaceId: string) { return this.svc.list(workspaceId); }
  @Get(":id") get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) { return this.svc.get(workspaceId, id); }
  @Post() create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateConversationDto) { return this.svc.create(workspaceId, dto); }
  @Patch(":id") update(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: UpdateConversationDto) {
    return this.svc.update(workspaceId, id, dto);
  }
  @Post(":id/read") markRead(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.markRead(workspaceId, id);
  }
  @Delete(":id") remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) { return this.svc.remove(workspaceId, id); }

  // Messages
  @Get(":id/messages") messages(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.listMessages(workspaceId, id);
  }
  /** Toggle the AI for one thread. Also clears a human-takeover pause. */
  @Post(":id/ai")
  setAi(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: { enabled?: boolean },
  ) {
    return this.svc.setAi(workspaceId, id, dto?.enabled === true);
  }

  @Post(":id/messages") send(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: CreateMessageDto) {
    return this.svc.addMessage(workspaceId, id, dto);
  }
}
