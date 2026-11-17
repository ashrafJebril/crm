import { Module } from "@nestjs/common";
import { MembersModule } from "../members/members.module";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";

@Module({
  // SP-26: member removal with handover, open-work and handover routes.
  imports: [MembersModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
