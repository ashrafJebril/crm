import { Controller, ExecutionContext, Get, HttpException } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsModule } from "../permissions/permissions.module";
import { KewyIdentityModule } from "../kewy-identity/kewy-identity.module";
import { EmailModule } from "../email/email.module";
import { AuditModule } from "../audit/audit.module";
import { AccountSecurityModule } from "../auth/account-security.module";
import { MembersModule } from "../members/members.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { BillingModule } from "./billing.module";
import { PlanFeatureGuard } from "./plan-feature.guard";
import { RequirePlanFeature } from "./plan-feature.decorator";
import { PlanService } from "./plan.service";
import { PLAN_REQUIRED } from "./billing-errors";

// AuthModule reads JWT_SECRET at import time: it is imported inside the test.
const SECRET = "test-secret-for-plan-feature-wiring-spec-0123456789";

@Controller("wired")
class WiredController {
  @Get("campaigns")
  @RequirePlanFeature("campaigns")
  campaigns() {
    return "ok";
  }
}

const ctx = (user: Record<string, unknown>): ExecutionContext =>
  ({
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => WiredController.prototype.campaigns,
    getClass: () => WiredController,
  }) as unknown as ExecutionContext;

describe("SP-28 plan gate through the real module wiring", () => {
  it("the global PlanFeatureGuard gets PlanService injected, so a placed feature on free returns 402", async () => {
    process.env.JWT_SECRET ||= SECRET;
    const { AuthModule } = await import("../auth/auth.module");
    const raw = { workspace: { findUnique: jest.fn(async () => ({ plan: "free", planOverriddenAt: null })) } };
    const mod = await Test.createTestingModule({
      imports: [PrismaModule, KewyIdentityModule, BillingModule, PermissionsModule, EmailModule, AuditModule, AccountSecurityModule, MembersModule, WorkspacesModule, AuthModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ raw })
      .compile();

    // The APP_GUARD instances AuthModule registered (AuthGuard, PermissionGuard, PlanFeatureGuard).
    // Nest renames APP_GUARD tokens internally: find the instance AuthModule built.
    const container = (mod as unknown as { container: { getModules(): Map<string, { metatype: unknown; providers: Map<unknown, { instance: unknown }> }> } }).container;
    const authModule = [...container.getModules().values()].find((m) => m.metatype === AuthModule)!;
    const appGuards = [...authModule.providers.entries()]
      .filter(([token]) => String(token).includes(APP_GUARD))
      .map(([, w]) => w.instance);
    expect(appGuards.map((g) => (g as object).constructor.name)).toEqual(["AuthGuard", "PermissionGuard", "PlanFeatureGuard"]);
    const gate = appGuards.find((g) => g instanceof PlanFeatureGuard) as PlanFeatureGuard | undefined;
    expect(gate).toBeDefined();
    // @Optional() must not have silently dropped the plan lookup.
    expect((gate as unknown as { plans?: unknown }).plans).toBeInstanceOf(PlanService);

    gate!.placement = { campaigns: "starter" };
    const err = (await gate!.canActivate(ctx({ sub: "u1", workspaceId: "ws1" })).catch((e) => e)) as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(402);
    expect(err.getResponse()).toMatchObject({ code: PLAN_REQUIRED, feature: "campaigns", requiredPlan: "starter" });
    expect(raw.workspace.findUnique).toHaveBeenCalledWith({ where: { id: "ws1" }, select: { plan: true, planOverriddenAt: true } });

    // The BillingModule export is wired the same way.
    expect((mod.get(PlanFeatureGuard, { strict: false }) as unknown as { plans?: unknown }).plans).toBeInstanceOf(PlanService);
    await mod.close();
  }, 60_000);
});
