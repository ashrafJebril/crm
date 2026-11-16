import { Controller, Get, Query } from "@nestjs/common";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import type { Viewer } from "../permissions/visibility";
import { InsightsService } from "./insights.service";

/**
 * SP-11 insights (`reports.view`, permission-map.ts). Every conversation-
 * derived figure is computed under the viewer's scope; a foreign or non-WhatsApp
 * `channelId` is 404 `insights.channel_not_found`; a bad range is 400
 * `insights.range_invalid`.
 */
@Controller("insights")
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  /** `GET /insights/support?from=YYYY-MM-DD&to=YYYY-MM-DD&channelId=` */
  @Get("support")
  support(
    @CurrentWorkspace() workspaceId: string,
    @CurrentViewer() viewer: Viewer,
    @Query("from") from?: unknown,
    @Query("to") to?: unknown,
    @Query("channelId") channelId?: unknown,
  ) {
    return this.insights.support(workspaceId, { from, to, channelId }, viewer);
  }

  /** `GET /insights/sales?from=YYYY-MM-DD&to=YYYY-MM-DD&pipelineId=`: a
   *  foreign or unknown pipeline is 404 `insights.pipeline_not_found`; every
   *  section is `forbidden` without `tickets.view`. */
  @Get("sales")
  sales(
    @CurrentWorkspace() workspaceId: string,
    @CurrentViewer() viewer: Viewer,
    @Query("from") from?: unknown,
    @Query("to") to?: unknown,
    @Query("pipelineId") pipelineId?: unknown,
  ) {
    return this.insights.sales(workspaceId, { from, to, pipelineId }, viewer);
  }
}
