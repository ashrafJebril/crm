import { Body, Controller, Delete, Get, HttpCode, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { META_ADS_MANAGE, MetaAdsService } from "./meta-ads.service";

/**
 * SP-15 Meta Ads connect. Permissions live in `permission-map.ts`:
 * `connection` (GET) is `connectors.view`; every other route but the public
 * OAuth callback is `connectors.manage`. Everything is scoped to the JWT
 * workspace; no route takes a path id.
 */
@Controller("meta-ads")
export class MetaAdsController {
  constructor(
    private readonly svc: MetaAdsService,
    private readonly perm: PermissionService,
  ) {}

  @Get("connection")
  async connection(@CurrentWorkspace() workspaceId: string, @CurrentViewer() viewer: Viewer) {
    return this.svc.connection(workspaceId, await this.perm.viewerCan(workspaceId, viewer, META_ADS_MANAGE));
  }

  @Get("oauth/start")
  start(@CurrentWorkspace() workspaceId: string, @CurrentViewer() viewer: Viewer) {
    return this.svc.start(workspaceId, viewer.userId);
  }

  /** Public: the state JWT and a `connectors.manage` re-check guard it. Always a 302. */
  @Public()
  @Get("oauth/callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Res() res: Response,
  ) {
    const out = await this.svc.callback({ code, state, error });
    return res.redirect(302, out.redirect);
  }

  @Get("candidates")
  candidates(@CurrentWorkspace() workspaceId: string, @Query("use") use?: string) {
    return this.svc.candidates(workspaceId, { use });
  }

  @Post("connection")
  @HttpCode(200)
  save(
    @CurrentWorkspace() workspaceId: string,
    @CurrentViewer() viewer: Viewer,
    @Body() body: { adAccountId?: unknown; pageId?: unknown },
  ) {
    return this.svc.save(workspaceId, viewer.userId, body ?? {});
  }

  @Post("check")
  @HttpCode(200)
  check(@CurrentWorkspace() workspaceId: string) {
    return this.svc.check(workspaceId);
  }

  @Delete("connection")
  disconnect(@CurrentWorkspace() workspaceId: string) {
    return this.svc.disconnect(workspaceId);
  }
}
