import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthGuard } from "./auth.guard";
import { SsoController } from "./sso.controller";
import { SsoService } from "./sso.service";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { requireJwtSecret } from "../common/jwt-secret";

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: requireJwtSecret(),
      signOptions: { expiresIn: "7d" },
    }),
    WorkspacesModule,
  ],
  // HJZ SSO bridge controller is inert unless AUTH_MODE=sso (the service
  // rejects calls), so registering it standalone-side is harmless.
  controllers: [AuthController, SsoController],
  providers: [
    AuthService,
    SsoService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
