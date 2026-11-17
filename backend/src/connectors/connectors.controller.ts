import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from "@nestjs/common";
import { CurrentUserId, CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { ConnectorsService } from "./connectors.service";

/**
 * SP-23 connector routes (permissions in permission-map.ts). `custom` is
 * declared before `:id`. Bodies are validated in the service so the error
 * keys are the documented ones. OAuth start/callback come with Task 2.
 */
@Controller("connectors")
export class ConnectorsController {
  constructor(
    private readonly connectors: ConnectorsService,
    private readonly perms: PermissionService,
  ) {}

  @Get()
  list(@CurrentWorkspace() ws: string) {
    return this.connectors.list(ws);
  }

  @Post("custom")
  createCustom(@CurrentWorkspace() ws: string, @CurrentUserId() userId: string, @Body() body: Record<string, unknown>) {
    return this.connectors.createCustom(ws, userId, body ?? {});
  }

  @Get(":id")
  detail(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.connectors.detail(ws, id);
  }

  @Patch(":id/tools")
  async patchTools(@CurrentWorkspace() ws: string, @CurrentViewer() viewer: Viewer, @Param("id") id: string, @Body() body: Record<string, unknown>) {
    // Ruling 11: switching a write tool on needs connectors.manage.
    const canManage = await this.perms.viewerCan(ws, viewer, "connectors.manage");
    return this.connectors.patchTools(ws, id, body ?? {}, canManage);
  }

  @Post(":id/rescan")
  rescan(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.connectors.rescan(ws, id);
  }

  @Put(":id/agent")
  setAgent(@CurrentWorkspace() ws: string, @Param("id") id: string, @Body() body: { bound?: unknown }) {
    return this.connectors.setAgent(ws, id, body?.bound === true);
  }

  @Get(":id/activity")
  activity(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.connectors.activity(ws, id);
  }

  @Delete(":id")
  disconnect(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.connectors.disconnect(ws, id);
  }
}
