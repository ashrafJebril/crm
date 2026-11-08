import { Body, Controller, Get, Post, Put, Query } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";
import {
  ListNotificationsQuery,
  MarkReadDto,
  UpdatePreferencesDto,
} from "./notifications.dto";
import {
  CurrentUserId,
  CurrentWorkspace,
} from "../common/current-workspace.decorator";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Query() q: ListNotificationsQuery,
  ) {
    return this.svc.list(workspaceId, userId, q.cursor, q.limit);
  }

  @Get("unread-count")
  unreadCount(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
  ) {
    return this.svc.unreadCount(workspaceId, userId);
  }

  @Post("read")
  markRead(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Body() dto: MarkReadDto,
  ) {
    return this.svc.markRead(workspaceId, userId, dto);
  }

  @Get("preferences")
  preferences(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
  ) {
    return this.svc.getPreferences(workspaceId, userId);
  }

  @Put("preferences")
  updatePreferences(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.svc.updatePreferences(workspaceId, userId, dto);
  }
}
