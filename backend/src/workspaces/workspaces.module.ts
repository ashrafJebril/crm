import { Module } from "@nestjs/common";
import { MembersModule } from "../members/members.module";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";
import { WorkspaceBrandingService } from "./workspace-branding.service";
import { BrandingPublicController } from "./branding-public.controller";
import { MediaModule } from "../media/media.module";

@Module({
  // SP-26: member removal with handover, open-work and handover routes.
  // SP-29: the logo is a Media row (MediaModule).
  imports: [MembersModule, MediaModule],
  controllers: [WorkspacesController, BrandingPublicController],
  providers: [WorkspacesService, WorkspaceBrandingService],
  exports: [WorkspacesService, WorkspaceBrandingService],
})
export class WorkspacesModule {}
