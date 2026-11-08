import { Controller, Get, Param } from "@nestjs/common";
import type { Viewer } from "../permissions/visibility";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import { RecordsService } from "./records.service";

@Controller("records")
export class RecordsController {
  constructor(private readonly svc: RecordsService) {}

  /** Mapped "authenticated"; the per-kind `<resource>.view` + conversation
   *  visibility check happens inside the service (404 when not allowed). */
  @Get(":kind/:id")
  get(
    @CurrentWorkspace() workspaceId: string,
    @Param("kind") kind: string,
    @Param("id") id: string,
    @CurrentViewer() viewer: Viewer,
  ) {
    return this.svc.get(workspaceId, viewer, kind, id);
  }
}
