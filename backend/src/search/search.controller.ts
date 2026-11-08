import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from "@nestjs/common";
import type { Viewer } from "../permissions/visibility";
import { SearchService } from "./search.service";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("search")
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  search(
    @CurrentWorkspace() workspaceId: string,
    @Query("q") q = "",
    @Query("limit", new DefaultValuePipe(8), ParseIntPipe) limit: number,
    @CurrentViewer() viewer?: Viewer,
  ) {
    const clamped = Math.min(Math.max(limit, 1), 25);
    return this.svc.search(workspaceId, q, clamped, viewer);
  }
}
