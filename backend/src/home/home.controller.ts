import { Controller, Get, HttpCode, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import type { Viewer } from "../permissions/visibility";
import { requestAbortSignal } from "../insights/request-signal";
import { HomeService } from "./home.service";

/**
 * SP-11 working home. Every route is `authenticated` (permission-map.ts):
 * each section is filtered in the service by the member's permissions and
 * conversation scope.
 */
@Controller("home")
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get()
  get(@CurrentWorkspace() workspaceId: string, @CurrentViewer() viewer: Viewer, @Res({ passthrough: true }) res?: Response) {
    return this.home.home(workspaceId, viewer, new Date(), res ? requestAbortSignal(res) : undefined);
  }

  @Post("seen")
  @HttpCode(200)
  seen(@CurrentWorkspace() workspaceId: string, @CurrentViewer() viewer: Viewer) {
    return this.home.seen(workspaceId, viewer);
  }

  @Post("day1/dismiss")
  @HttpCode(200)
  dismissDay1(@CurrentWorkspace() workspaceId: string, @CurrentViewer() viewer: Viewer) {
    return this.home.dismissDay1(workspaceId, viewer);
  }
}
