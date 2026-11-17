import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthGuard } from "./auth.guard";
import { SsoController } from "./sso.controller";
import { SsoService } from "./sso.service";
import { KewySsoController } from "./kewy-sso.controller";
import { KewySsoService } from "./kewy-sso.service";
import { TiremallSsoController } from "./tiremall-sso.controller";
import { TiremallSsoService } from "./tiremall-sso.service";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { requireJwtSecret } from "../common/jwt-secret";
import { PermissionsModule } from "../permissions/permissions.module";
import { PermissionGuard } from "../permissions/permission.guard";
import { MembersModule } from "../members/members.module";
import { PublicInvitationsController } from "../members/public-invitations.controller";

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: requireJwtSecret(),
      signOptions: { expiresIn: "7d" },
    }),
    WorkspacesModule,
    PermissionsModule,
    // SP-26: the invitee's routes (GET /auth/invitations, accept).
    MembersModule,
  ],
  // HJZ SSO bridge controller is inert unless AUTH_MODE=sso (the service
  // rejects calls), so registering it standalone-side is harmless.
  // SP-26: PublicInvitationsController lives in members/ but needs AuthService
  // to issue the session, so it is registered here (no module cycle).
  controllers: [AuthController, SsoController, KewySsoController, TiremallSsoController, PublicInvitationsController],
  providers: [
    AuthService,
    SsoService,
    KewySsoService,
    TiremallSsoService,
    { provide: APP_GUARD, useClass: AuthGuard },
    // Must stay directly after AuthGuard: global guards run in registration
    // order, and PermissionGuard needs the req.user AuthGuard sets. (An
    // APP_GUARD in AppModule would run BEFORE this module's AuthGuard.)
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
