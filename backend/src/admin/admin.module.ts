import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { SuperAdminGuard } from "./super-admin.guard";
import { requireJwtSecret } from "../common/jwt-secret";

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: requireJwtSecret(),
      }),
    }),
  ],
  controllers: [AdminController],
  providers: [AdminService, SuperAdminGuard],
  // JoteckModule reuses provisionClient so there is one provisioning routine.
  exports: [AdminService],
})
export class AdminModule {}
