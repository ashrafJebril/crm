import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import type { Viewer } from "../permissions/visibility";
import { CurrentUserId, CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import { ActivitiesService } from "./activities.service";
import {
  BulkActivitiesDto,
  CompleteActivityDto,
  CreateActivityDto,
  ListActivitiesQuery,
  NextStepsQuery,
  QueueQuery,
  UpdateActivityDto,
} from "./activities.dto";

/** Permission is checked per activity in ActivitiesService (contacts.* or
 *  tickets.* by link), so every route is "authenticated" in the permission map. */
@Controller("activities")
export class ActivitiesController {
  constructor(private readonly svc: ActivitiesService) {}

  @Get()
  list(@CurrentWorkspace() ws: string, @Query() q: ListActivitiesQuery, @CurrentViewer() viewer: Viewer) {
    return this.svc.list(ws, q, viewer);
  }

  // Static segments are declared before ":id" routes.
  @Get("queue")
  queue(@CurrentWorkspace() ws: string, @Query() q: QueueQuery, @CurrentViewer() viewer: Viewer) {
    return this.svc.queue(ws, q, viewer);
  }

  @Get("next-steps")
  nextSteps(@CurrentWorkspace() ws: string, @Query() q: NextStepsQuery, @CurrentViewer() viewer: Viewer) {
    return this.svc.nextSteps(ws, q, viewer);
  }

  @Post()
  create(
    @CurrentWorkspace() ws: string,
    @Body() dto: CreateActivityDto,
    @CurrentUserId() userId: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.create(ws, dto, userId, viewer);
  }

  @Post("bulk")
  bulk(
    @CurrentWorkspace() ws: string,
    @Body() dto: BulkActivitiesDto,
    @CurrentUserId() userId: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.bulk(ws, dto, userId, viewer);
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() ws: string,
    @Param("id") id: string,
    @Body() dto: UpdateActivityDto,
    @CurrentUserId() userId: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.update(ws, id, dto, userId, viewer);
  }

  @Post(":id/complete")
  complete(
    @CurrentWorkspace() ws: string,
    @Param("id") id: string,
    @Body() dto: CompleteActivityDto,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.complete(ws, id, dto, viewer);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() ws: string, @Param("id") id: string, @CurrentViewer() viewer: Viewer) {
    return this.svc.remove(ws, id, viewer);
  }
}
