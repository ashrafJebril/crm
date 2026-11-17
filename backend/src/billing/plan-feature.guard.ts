import { CanActivate, ExecutionContext, Injectable, Optional } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { JwtPayload } from "../auth/auth.guard";
import { routeKeysFor } from "../permissions/permission-map";
import { planRequired } from "./billing-errors";
import { FEATURE_MIN_PLAN, planIncludes, requiredPlanFor, type Feature, type PlanKey } from "./plan-catalog";
import { PLAN_FEATURE_KEY } from "./plan-feature.decorator";
import { PLAN_FEATURE_ROUTES } from "./plan-feature-map";
import { PlanService } from "./plan.service";

/**
 * SP-28 plan gate. Registered as the third APP_GUARD, after AuthGuard and
 * PermissionGuard, so a member without the permission still gets 403 and a
 * locked workspace its 403 PAYMENT_OVERDUE; 402 means only "not in your plan".
 * - The feature comes from @RequirePlanFeature or PLAN_FEATURE_ROUTES.
 * - Super-admins and impersonators pass (as with the payment lock).
 * - Unknown (Kewy package) plans and unplaced features pass (R3, R4).
 */
@Injectable()
export class PlanFeatureGuard implements CanActivate {
  /** Tests may place features; production uses the catalogue's (empty in v1). */
  placement: Readonly<Partial<Record<Feature, PlanKey>>> = FEATURE_MIN_PLAN;
  routes: Readonly<Record<string, Feature>> = PLAN_FEATURE_ROUTES;

  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly plans?: PlanService,
  ) {}

  featureFor(ctx: ExecutionContext): Feature | undefined {
    const explicit = this.reflector.get<Feature | undefined>(PLAN_FEATURE_KEY, ctx.getHandler());
    if (explicit) return explicit;
    for (const key of routeKeysFor(ctx.getClass(), ctx.getHandler())) {
      const f = this.routes[key];
      if (f) return f;
    }
    return undefined;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== "http") return true;
    const feature = this.featureFor(ctx);
    if (!feature || !this.plans) return true;
    const user = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>().user;
    if (!user?.workspaceId) return true;
    if (user.isSuperAdmin === true || user.impersonating === true) return true;
    const { plan } = await this.plans.planOf(user.workspaceId);
    if (planIncludes(plan, feature, this.placement)) return true;
    throw planRequired(feature, requiredPlanFor(feature, this.placement));
  }
}
