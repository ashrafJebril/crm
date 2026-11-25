import { SetMetadata } from "@nestjs/common";
import type { Feature } from "./plan-catalog";

export const PLAN_FEATURE_KEY = "sp28:planFeature";

/**
 * SP-28: the route needs a plan feature. Without it the request gets 402
 * `{code: "PLAN_REQUIRED", feature, requiredPlan}` (PlanFeatureGuard), after
 * the permission check. R3/R4: nothing is gated until the user places
 * features in `FEATURE_MIN_PLAN`.
 */
export const RequirePlanFeature = (feature: Feature) => SetMetadata(PLAN_FEATURE_KEY, feature);
