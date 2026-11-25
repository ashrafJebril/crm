import type { Feature } from "./plan-catalog";

/**
 * SP-28: routes gated by a plan feature, keyed like the permission map
 * ("METHOD /path"). Empty in v1 (R3): the user has not placed features yet,
 * and R4 allows gating only features new in Phase 3–6, on `free` only. A spec
 * checks every entry exists in permission-map.ts and is a Phase 3–6 route.
 */
export const PLAN_FEATURE_ROUTES: Readonly<Record<string, Feature>> = Object.freeze({});
