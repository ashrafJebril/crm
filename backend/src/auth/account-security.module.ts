import { Global, Module } from "@nestjs/common";
import { PasswordResetService } from "./password-reset.service";
import { SessionVersionService } from "./session-version.service";
import { TwoFactorService } from "./two-factor.service";

/**
 * SP-26 account security: session versions (read by AuthGuard), password
 * reset and TOTP two-step verification. Global and dependent only on other
 * global modules (Prisma, permissions, audit, email, Kewy sync, the global
 * JwtModule), so AuthModule and WorkspacesModule can both use it without a
 * module cycle.
 */
@Global()
@Module({
  providers: [SessionVersionService, PasswordResetService, TwoFactorService],
  exports: [SessionVersionService, PasswordResetService, TwoFactorService],
})
export class AccountSecurityModule {}
