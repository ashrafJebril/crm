import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from "@nestjs/common";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import type { Viewer } from "../permissions/visibility";
import { ConversationLabelsService } from "./conversation-labels.service";
import {
  CreateConversationLabelDto,
  SetConversationLabelsDto,
  UpdateConversationLabelDto,
} from "./conversation-labels.dto";

@Controller()
export class ConversationLabelsController {
  constructor(private readonly svc: ConversationLabelsService) {}

  @Get("conversation-labels")
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Post("conversation-labels")
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateConversationLabelDto) {
    return this.svc.create(workspaceId, dto);
  }

  @Patch("conversation-labels/:id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateConversationLabelDto,
  ) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Delete("conversation-labels/:id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.remove(workspaceId, id);
  }

  @Put("conversations/:id/labels")
  setLabels(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: SetConversationLabelsDto,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.setForConversation(workspaceId, id, dto.labelIds, viewer);
  }
}
