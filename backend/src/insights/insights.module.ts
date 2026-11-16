import { Module } from "@nestjs/common";
import { InsightsController } from "./insights.controller";
import { InsightsService } from "./insights.service";

/** SP-11 insights. PermissionService comes from the global PermissionsModule. */
@Module({
  controllers: [InsightsController],
  providers: [InsightsService],
  exports: [InsightsService],
})
export class InsightsModule {}
