import { CHANNEL_LIMITS } from "../channels/channel-limits";
import {
  FEATURE_MIN_PLAN,
  FEATURES,
  PLAN_KEYS,
  PLANS,
  featuresOf,
  planIncludes,
  planKeyOf,
  publicCatalog,
  requiredPlanFor,
} from "./plan-catalog";

describe("SP-28 plan catalogue (Kewy-billed)", () => {
  it("grandfathered plans keep every current feature", () => {
    // R4 + R3: every catalogue plan, and any Kewy package name, includes every feature today.
    for (const plan of [...PLAN_KEYS, "Ultimate", "Basic Package", "", null, undefined]) {
      expect({ plan, features: featuresOf(plan) }).toEqual({ plan, features: [...FEATURES] });
    }
  });

  it("R4: only `free` may ever be gated, and nothing is placed until the user decides (R3)", () => {
    expect(FEATURE_MIN_PLAN).toEqual({});
    for (const min of Object.values(FEATURE_MIN_PLAN)) expect(min).toBe("starter");
  });

  it("a placed feature gates free only; paying plans and Kewy packages keep it", () => {
    const placement = { campaigns: "starter" as const };
    expect(planIncludes("free", "campaigns", placement)).toBe(false);
    expect(planIncludes("FREE ", "campaigns", placement)).toBe(false);
    for (const p of ["starter", "growth", "pro", "Ultimate"]) expect(planIncludes(p, "campaigns", placement)).toBe(true);
    expect(planIncludes("free", "insights", placement)).toBe(true);
    expect(requiredPlanFor("campaigns", placement)).toBe("starter");
    expect(requiredPlanFor("insights", placement)).toBeNull();
  });

  it("maps stored plans: CRM keys case-insensitively, Kewy package names to null", () => {
    expect(planKeyOf("growth")).toBe("growth");
    expect(planKeyOf(" Pro ")).toBe("pro");
    expect(planKeyOf("Ultimate")).toBeNull();
    expect(planKeyOf(null)).toBeNull();
  });

  it("WhatsApp-number limits come from CHANNEL_LIMITS (one source)", () => {
    for (const k of PLAN_KEYS) expect(PLANS[k].limits.whatsappNumbers).toBe(CHANNEL_LIMITS[k]);
  });

  it("catalog hides placeholders until the user sets them (R3)", () => {
    const c = publicCatalog();
    expect(c.billedBy).toBe("kewy");
    expect(c.plans.map((p) => p.key)).toEqual([...PLAN_KEYS]);
    for (const p of c.plans) {
      expect(p).not.toHaveProperty("priceJod");
      expect(p).not.toHaveProperty("allowances");
      expect(p.limits).not.toHaveProperty("seats");
      expect(p.features).toEqual([...FEATURES]);
    }
    // Nothing Stripe-shaped is exposed.
    expect(JSON.stringify(c)).not.toMatch(/stripe|price_|checkout/i);
  });
});
