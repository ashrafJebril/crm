import { Controller, Get, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { WorkspaceBrandingService } from "./workspace-branding.service";

/**
 * SP-29 (ruling 6): `GET /branding/:workspaceId/logo/:mediaId`, public (the
 * hosted chat page and emails load it without a session). It serves only the
 * workspace's current logo; anything else is 404, so it cannot read a library
 * file. Same-origin bytes, never a redirect; nosniff, `default-src 'none'`,
 * immutable cache.
 */
@Controller("branding")
export class BrandingPublicController {
  constructor(private readonly branding: WorkspaceBrandingService) {}

  @Public()
  @Get(":workspaceId/logo/:mediaId")
  async logo(@Param("workspaceId") workspaceId: string, @Param("mediaId") mediaId: string, @Res() res: Response): Promise<void> {
    await this.branding.serveLogo(workspaceId, mediaId, res);
  }
}
