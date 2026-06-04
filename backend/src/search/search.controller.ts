import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from "@nestjs/common";
import { SearchService } from "./search.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("search")
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  search(
    @CurrentWorkspace() workspaceId: string,
    @Query("q") q = "",
    @Query("limit", new DefaultValuePipe(8), ParseIntPipe) limit: number,
  ) {
    const clamped = Math.min(Math.max(limit, 1), 25);
    return this.svc.search(workspaceId, q, clamped);
  }
}
