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
  @Post(":id/ai/pause") pauseAi(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.setAiPaused(workspaceId, id, true);
  }
  @Delete(":id/ai/pause") resumeAi(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.setAiPaused(workspaceId, id, false);
  }
  @Delete(":id") remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) { return this.svc.remove(workspaceId, id); }

  // Messages
  @Get(":id/messages") messages(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.listMessages(workspaceId, id);
  }
  @Post(":id/messages") send(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: CreateMessageDto) {
    return this.svc.addMessage(workspaceId, id, dto);
  }
}
