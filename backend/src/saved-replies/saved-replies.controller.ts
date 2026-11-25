import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { SavedRepliesService } from "./saved-replies.service";
import { CreateSavedReplyDto, UpdateSavedReplyDto } from "./saved-replies.dto";

@Controller("saved-replies")
export class SavedRepliesController {
  constructor(private readonly svc: SavedRepliesService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateSavedReplyDto) {
    return this.svc.create(workspaceId, dto);
  }

  @Patch(":id")
  update(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: UpdateSavedReplyDto) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.remove(workspaceId, id);
  }
}
