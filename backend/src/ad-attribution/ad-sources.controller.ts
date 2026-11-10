import { Controller, Get, Param, Query } from "@nestjs/common";
import type { Viewer } from "../permissions/visibility";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import { AdSourcesService } from "./ad-sources.service";

/**
 * SP-15 ad sources. Task 2 adds `GET /ad-sources/overview` and
 * `GET /ad-sources/:id` here; `overview` must be declared before `:id`.
 */
@Controller("ad-sources")
export class AdSourcesController {
  constructor(private readonly svc: AdSourcesService) {}

  /** The inbox Ad source filter's options (conversations.view). */
  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.listForFilter(workspaceId);
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
