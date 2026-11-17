import { Controller, ExecutionContext, Get, HttpException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { readFileSync } from "fs";
import { join } from "path";
import { ROUTE_PERMISSIONS } from "../permissions/permission-map";
import { RequirePlanFeature } from "./plan-feature.decorator";
import { PlanFeatureGuard } from "./plan-feature.guard";
import { PLAN_FEATURE_ROUTES } from "./plan-feature-map";
import { PLAN_REQUIRED } from "./billing-errors";

@Controller("gated")
class GatedController {
  @Get("campaigns")
  @RequirePlanFeature("campaigns")
  campaigns() {
    return "ok";
  }

  @Get("open")
  open() {
    return "ok";
  }

  @Get("mapped")
  mapped() {
    return "ok";
  }
}

function ctxFor(handler: Function, user: Record<string, unknown> | undefined): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => GatedController,
  } as unknown as ExecutionContext;
}

function build(plan: string) {
  const plans = { planOf: jest.fn(async () => ({ plan, overridden: false })) };
  const guard = new PlanFeatureGuard(new Reflector(), plans as never);
  guard.placement = { campaigns: "starter", insights: "starter" };
  guard.routes = { "GET /gated/mapped": "insights" };
  return { guard, plans };
}

const member = { sub: "u1", workspaceId: "ws1" };
const proto = GatedController.prototype;

describe("SP-28 plan gate", () => {
  it("feature gated by plan returns 402 PLAN_REQUIRED and UI shows upgrade", async () => {
    const { guard } = build("free");
    const err = (await guard.canActivate(ctxFor(proto.campaigns, member)).catch((e) => e)) as HttpException;
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(402);
    expect(err.getResponse()).toEqual({
      statusCode: 402,
      code: PLAN_REQUIRED,
      message: "billing.plan_required",
      feature: "campaigns",
      requiredPlan: "starter",
    });
    // A route listed in PLAN_FEATURE_ROUTES is gated the same way.
    const mapped = (await guard.canActivate(ctxFor(proto.mapped, member)).catch((e) => e)) as HttpException;
    expect(mapped.getResponse()).toMatchObject({ code: PLAN_REQUIRED, feature: "insights" });
    // starter passes; an ungated route passes on free.
    await expect(build("starter").guard.canActivate(ctxFor(proto.campaigns, member))).resolves.toBe(true);
    await expect(guard.canActivate(ctxFor(proto.open, member))).resolves.toBe(true);
  });

  it("grandfathered: a Kewy package name and every paying plan pass", async () => {
    for (const plan of ["starter", "growth", "pro", "Ultimate"]) {
      await expect(build(plan).guard.canActivate(ctxFor(proto.campaigns, member))).resolves.toBe(true);
    }
  });

  it("super-admin and impersonator bypass plan gate", async () => {
    const { guard, plans } = build("free");
    await expect(guard.canActivate(ctxFor(proto.campaigns, { ...member, isSuperAdmin: true }))).resolves.toBe(true);
    await expect(guard.canActivate(ctxFor(proto.campaigns, { ...member, impersonating: true }))).resolves.toBe(true);
    expect(plans.planOf).not.toHaveBeenCalled();
  });

  it("with the v1 catalogue nothing is gated (R3)", async () => {
    const plans = { planOf: jest.fn(async () => ({ plan: "free", overridden: false })) };
    const guard = new PlanFeatureGuard(new Reflector(), plans as never);
    await expect(guard.canActivate(ctxFor(proto.campaigns, member))).resolves.toBe(true);
    await expect(guard.canActivate(ctxFor(proto.mapped, member))).resolves.toBe(true);
  });

  it("the 402 is raised only after PermissionGuard (registration order)", () => {
    const src = readFileSync(join(__dirname, "..", "auth", "auth.module.ts"), "utf8");
    const at = (name: string) => src.indexOf(`{ provide: APP_GUARD, useClass: ${name} }`);
    expect(at("AuthGuard")).toBeGreaterThan(-1);
    expect(at("PermissionGuard")).toBeGreaterThan(at("AuthGuard"));
    expect(at("PlanFeatureGuard")).toBeGreaterThan(at("PermissionGuard"));
  });

  it("plan feature map routes exist in the permission map", () => {
    for (const key of Object.keys(PLAN_FEATURE_ROUTES)) {
      expect({ key, mapped: key in ROUTE_PERMISSIONS }).toEqual({ key, mapped: true });
    }
    expect(PLAN_FEATURE_ROUTES).toEqual({}); // R3: nothing gated in v1
  });
});
