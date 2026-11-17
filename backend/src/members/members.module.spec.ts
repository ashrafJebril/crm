import { Test } from "@nestjs/testing";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsModule } from "../permissions/permissions.module";
import { KewyIdentityModule } from "../kewy-identity/kewy-identity.module";
import { BillingModule } from "../billing/billing.module";
import { EmailModule } from "../email/email.module";
import { AuditModule } from "../audit/audit.module";
import { AccountSecurityModule } from "../auth/account-security.module";
import { TwoFactorService } from "../auth/two-factor.service";
import { EMAIL_SENDER } from "../email/email-sender";
import { MembersModule } from "./members.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { WorkspacesController } from "../workspaces/workspaces.controller";
import { AuthController } from "../auth/auth.controller";
import { HandoverService } from "./handover.service";
import { InvitationsService } from "./invitations.service";
import { PublicInvitationsController } from "./public-invitations.controller";

// AuthModule reads JWT_SECRET at import time: it is imported inside the test.
const SECRET = "test-secret-for-members-module-spec-0123456789";

describe("SP-26 module wiring (no database)", () => {
  it("resolves the members, workspace and auth providers without a cycle; email defaults to off", async () => {
    delete process.env.EMAIL_PROVIDER;
    process.env.JWT_SECRET ||= SECRET;
    const { AuthModule } = await import("../auth/auth.module");
    const mod = await Test.createTestingModule({
      imports: [PrismaModule, KewyIdentityModule, BillingModule, PermissionsModule, EmailModule, AuditModule, AccountSecurityModule, MembersModule, WorkspacesModule, AuthModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    expect(mod.get(InvitationsService)).toBeInstanceOf(InvitationsService);
    expect(mod.get(HandoverService)).toBeInstanceOf(HandoverService);
    const ws = mod.get(WorkspacesController);
    expect((ws as unknown as { handover?: unknown }).handover).toBeInstanceOf(HandoverService);
    expect((ws as unknown as { twoFactor?: unknown }).twoFactor).toBeInstanceOf(TwoFactorService);
    expect(mod.get(AuthController)).toBeDefined();
    expect(mod.get(PublicInvitationsController)).toBeDefined();
    expect(mod.get<{ enabled: boolean }>(EMAIL_SENDER).enabled).toBe(false);
    await mod.close();
  });
});
