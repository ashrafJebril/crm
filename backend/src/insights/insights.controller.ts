import { Controller, Get, Query } from "@nestjs/common";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import type { Viewer } from "../permissions/visibility";
import { InsightsService } from "./insights.service";

/**
 * SP-11 insights (`reports.view`, permission-map.ts). Every figure is computed
 * under the viewer's conversation scope; a foreign or non-WhatsApp
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
}
