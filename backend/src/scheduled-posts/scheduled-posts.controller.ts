import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { ScheduledPostsService } from "./scheduled-posts.service";
import { CreateScheduledPostDto } from "./scheduled-posts.dto";
import { CurrentWorkspace, CurrentUserId } from "../common/current-workspace.decorator";

@Controller("scheduled-posts")
export class ScheduledPostsController {
  constructor(private readonly svc: ScheduledPostsService) {}

  @Get()
  list(
    @CurrentWorkspace() workspaceId: string,
    @Query("status") status?: string,
  ) {
    return this.svc.list(workspaceId, status);
  }

  @Post()
  create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Body() dto: CreateScheduledPostDto,
  ) {
    return this.svc.create(workspaceId, userId, dto);
  }

  @Delete(":id")
  cancel(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
  ) {
    return this.svc.cancel(workspaceId, id);
  }

  /** Manual trigger for the worker — useful during dev/testing. */
  @Post("_admin/run")
  runOnce() {
    const base =
      process.env.PUBLIC_BASE_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3001";
    return this.svc.runTick(base);
  }
}
