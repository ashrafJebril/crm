import { Body, Controller, Delete, Get, Optional, Param, Patch, Post, Query } from "@nestjs/common";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { ChannelsService } from "./channels.service";
import { CreateChannelDto, UpdateChannelDto } from "./channels.dto";

/**
 * Channels hub. Permissions (permission-map.ts): channels.view for reads,
 * channels.create / update / delete for writes. None of these read
 * conversation data, so no viewer scoping applies beyond the permission.
 */
@Controller("channels")
export class ChannelsController {
  constructor(
    private readonly svc: ChannelsService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string, @Query("kind") kind?: string) {
    return this.svc.list(workspaceId, kind || undefined);
  }

  /** Declared before `:id`. `secretsEncryption` only for channels.update holders. */
  @Get("limits")
  async limits(@CurrentWorkspace() workspaceId: string, @CurrentViewer() viewer?: Viewer) {
    const canManage = this.perm ? await this.perm.viewerCan(workspaceId, viewer, "channels.update") : false;
    return this.svc.limits(workspaceId, canManage);
  }

  @Post("sync")
  sync(@CurrentWorkspace() workspaceId: string) {
    return this.svc.sync(workspaceId);
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.get(workspaceId, id);
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateChannelDto) {
    return this.svc.createWebchat(workspaceId, dto);
  }

  @Patch(":id")
  update(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: UpdateChannelDto) {
    return this.svc.update(workspaceId, id, dto);
  }

  /** Soft disconnect (R9). */
  @Delete(":id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.disconnect(workspaceId, id);
  }
}
