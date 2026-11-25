import { CHANNEL_LIMITS } from "../channels/channel-limits";

/**
 * SP-28 plan catalogue, re-scoped: Kewy/Joteck stays the biller, so there are
 * no prices to charge and no checkout here. The catalogue names the plan keys
 * `Workspace.plan` already holds, what each one includes, and the usage
 * allowances shown against metered usage.
 *
 * R3: prices, allowances and which plan holds which feature are the user's
 * business inputs. Until the user sets them, every value below is `null`
 * (TODO(user)), `GET /billing/catalog` hides them, and nothing new is gated.
 * R4: v1 may gate only features new in Phase 3–6, and only on `free`; every
 * paying plan, and any Kewy package name the catalogue does not know, keeps
 * every feature it has today.
 */
export const PLAN_KEYS = ["free", "starter", "growth", "pro"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const FEATURES = [
  "campaigns",
  "smart_audiences",
  "insights",
  "api_access",
  "webhooks",
  "ai_tools",
  "bookings_catalog_import",
  "copilot",
] as const;
export type Feature = (typeof FEATURES)[number];

export const METERS = ["ai_reply", "campaign_message", "ads_ai"] as const;
export type Meter = (typeof METERS)[number];

export interface PlanDef {
  key: PlanKey;
  rank: number;
  /** Monthly price in JOD; null = not set by the user yet (hidden). Kewy bills it. */
  priceJod: { monthly: number | null; annual: number | null };
  /** Per-period usage allowances; null = not set (no allowance shown). */
  allowances: Record<Meter, number | null>;
  limits: { whatsappNumbers: number; seats: number | null };
}

const NONE: Record<Meter, null> = { ai_reply: null, campaign_message: null, ads_ai: null };

export const PLANS: Readonly<Record<PlanKey, PlanDef>> = Object.freeze({
  // TODO(user): prices, allowances and seats (R3).
  free: { key: "free", rank: 0, priceJod: { monthly: null, annual: null }, allowances: NONE, limits: { whatsappNumbers: CHANNEL_LIMITS.free, seats: null } },
  starter: { key: "starter", rank: 1, priceJod: { monthly: null, annual: null }, allowances: NONE, limits: { whatsappNumbers: CHANNEL_LIMITS.starter, seats: null } },
  growth: { key: "growth", rank: 2, priceJod: { monthly: null, annual: null }, allowances: NONE, limits: { whatsappNumbers: CHANNEL_LIMITS.growth, seats: null } },
  pro: { key: "pro", rank: 3, priceJod: { monthly: null, annual: null }, allowances: NONE, limits: { whatsappNumbers: CHANNEL_LIMITS.pro, seats: null } },
});

/**
 * The lowest plan that includes a feature (R3, R4). Empty until the user
 * places features: then nothing is gated. R4 allows only "starter" here (the
 * gate applies to `free` alone); a spec enforces it.
 */
export const FEATURE_MIN_PLAN: Readonly<Partial<Record<Feature, PlanKey>>> = Object.freeze({});

export const isPlanKey = (v: unknown): v is PlanKey => typeof v === "string" && (PLAN_KEYS as readonly string[]).includes(v);

/**
 * The catalogue key of a stored plan. `Workspace.plan` holds either a CRM key
 * or the name of a Kewy package (e.g. "Ultimate"), pushed by Kewy. A name the
 * catalogue does not know is a Kewy package: null, and grandfathered.
 */
export function planKeyOf(plan: string | null | undefined): PlanKey | null {
  const k = (plan ?? "").trim().toLowerCase();
  return isPlanKey(k) ? k : null;
}

/** Whether a plan includes a feature. Unknown (Kewy package) plans and features nobody placed yet: included. */
export function planIncludes(
  plan: string | null | undefined,
  feature: Feature,
  placement: Readonly<Partial<Record<Feature, PlanKey>>> = FEATURE_MIN_PLAN,
): boolean {
  const min = placement[feature];
  if (!min) return true;
  const key = planKeyOf(plan);
  if (!key) return true;
  return PLANS[key].rank >= PLANS[min].rank;
}

/** The features a plan includes. */
export function featuresOf(
  plan: string | null | undefined,
  placement: Readonly<Partial<Record<Feature, PlanKey>>> = FEATURE_MIN_PLAN,
): Feature[] {
  return FEATURES.filter((f) => planIncludes(plan, f, placement));
}

/** The plan a feature needs, for the 402 body; null when it is not gated. */
export function requiredPlanFor(
  feature: Feature,
  placement: Readonly<Partial<Record<Feature, PlanKey>>> = FEATURE_MIN_PLAN,
): PlanKey | null {
  return placement[feature] ?? null;
}

/**
 * The public catalogue (`GET /billing/catalog`): only values the user has
 * set. A plan whose price and allowances are all unset shows only its key,
 * rank and WhatsApp-number limit (R3: placeholders stay hidden).
 */
export function publicCatalog() {
  return {
    billedBy: "kewy" as const,
    plans: PLAN_KEYS.map((k) => {
      const p = PLANS[k];
      const allowances = Object.fromEntries(Object.entries(p.allowances).filter(([, v]) => v !== null));
      return {
        key: k,
        rank: p.rank,
        ...(p.priceJod.monthly !== null ? { priceJod: p.priceJod } : {}),
        ...(Object.keys(allowances).length ? { allowances } : {}),
        limits: { whatsappNumbers: p.limits.whatsappNumbers, ...(p.limits.seats !== null ? { seats: p.limits.seats } : {}) },
        features: featuresOf(k),
      };
    }),
    features: [...FEATURES],
  };
}
