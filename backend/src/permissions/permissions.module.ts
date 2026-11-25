import { Global, Module } from "@nestjs/common";
import { PermissionService } from "./permission.service";
import { PermissionGuard } from "./permission.guard";
import { PermissionsController } from "./permissions.controller";

/** Global so any feature module can inject PermissionService. The guard
 *  itself is registered as an APP_GUARD in AuthModule, after AuthGuard. */
@Global()
@Module({
  controllers: [PermissionsController],
  providers: [PermissionService, PermissionGuard],
  exports: [PermissionService, PermissionGuard],
})
export class PermissionsModule {}
