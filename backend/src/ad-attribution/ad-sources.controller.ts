import { Controller, Get, Param, Query } from "@nestjs/common";
import type { Viewer } from "../permissions/visibility";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import { AdSourcesService } from "./ad-sources.service";
import { AdsMetricsService } from "./ads-metrics.service";

/**
 * SP-15 ad sources. `overview` is declared before `:id`, so it is never
 * captured as an id.
 */
@Controller("ad-sources")
export class AdSourcesController {
  constructor(
    private readonly svc: AdSourcesService,
    private readonly metrics: AdsMetricsService,
  ) {}

  /** The inbox Ad source filter's options (conversations.view). */
  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.listForFilter(workspaceId);
  }

  /** The Ads tab: totals per currency, the daily chart and one card per ad (reports.view). */
  @Get("overview")
  overview(@CurrentWorkspace() workspaceId: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.metrics.overview(workspaceId, { from, to });
  }

  /** One ad's card with its daily series (reports.view). 404 `ads.not_found`. */
  @Get(":id")
  detail(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.metrics.detail(workspaceId, id, { from, to });
  }

  /** The ad's conversations, ANDed with the viewer's conversation scope. */
  @Get(":id/conversations")
  conversations(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @CurrentViewer() viewer: Viewer,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.svc.conversations(workspaceId, id, viewer, { from, to, cursor, limit });
  }
}
