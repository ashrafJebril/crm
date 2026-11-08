import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import type { Viewer } from "../permissions/visibility";
import { ConversationsService } from "./conversations.service";
import {
  CreateConversationDto,
  CreateMessageDto,
  UpdateConversationDto,
} from "./conversations.dto";
import { CurrentUserId, CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly svc: ConversationsService) {}

  @Get() list(@CurrentWorkspace() workspaceId: string, @CurrentViewer() viewer: Viewer) { return this.svc.list(workspaceId, viewer); }
  @Get(":id") get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @CurrentViewer() viewer: Viewer) { return this.svc.get(workspaceId, id, viewer); }
  @Post() create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateConversationDto) { return this.svc.create(workspaceId, dto); }
  @Patch(":id") update(@CurrentWorkspace() workspaceId: string, @CurrentUserId() userId: string, @Param("id") id: string, @Body() dto: UpdateConversationDto, @CurrentViewer() viewer: Viewer) {
    return this.svc.update(workspaceId, id, dto, userId, viewer);
  }
  @Post(":id/read") markRead(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @CurrentViewer() viewer: Viewer) {
    return this.svc.markRead(workspaceId, id, viewer);
  }
  @Delete(":id") remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @CurrentViewer() viewer: Viewer) { return this.svc.remove(workspaceId, id, viewer); }

  // Messages
  @Get(":id/messages") messages(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @CurrentViewer() viewer: Viewer) {
    return this.svc.listMessages(workspaceId, id, viewer);
  }
  /** Toggle the AI for one thread. Also clears a human-takeover pause. */
  @Post(":id/ai")
  setAi(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: { enabled?: boolean },
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.setAi(workspaceId, id, dto?.enabled === true, viewer);
  }

  @Post(":id/messages") send(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: CreateMessageDto, @CurrentViewer() viewer: Viewer) {
    return this.svc.addMessage(workspaceId, id, dto, viewer);
  }
}
