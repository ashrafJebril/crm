/**
 * SP-20 onboarding state machine (pure). Stored in `Workspace.onboardingState`;
 * null means the workspace never started onboarding (every workspace that
 * existed before SP-20; ruling 10) and nothing ever starts it by itself.
 *
 *  - start  : null / not_started → in_progress (the caller becomes the
 *             starter); skipped → in_progress (resume); in_progress by the
 *             same member → unchanged; by another member → 409 not_owner.
 *  - skip   : in_progress (starter only) → skipped, the step kept.
 *  - resume : skipped → in_progress, the step kept, the resumer is the starter.
 *  - step   : in_progress (starter only) → the given step; leaving "business"
 *             needs a business name, "learn" needs a website.
 *  - finish : in_progress (starter only) → done (final: every later action is
 *             409 onboarding.done).
 *  - takeover / reset (`rescue`): a member with settings.manage takes over or
 *             resets an onboarding whose starter left or that has not moved
 *             for 24 h (review); `transition` refuses them.
 */
import { BUSINESS_NAME_MAX, ONBOARDING_STEPS, type OnboardingStatus, type OnboardingStep } from "../agent-constants";
import { agentError } from "../agent-errors";
import type { LearnCard } from "./learn-schema";

export interface OnboardingState {
  status: OnboardingStatus;
  step: OnboardingStep;
  businessName: string | null;
  websiteUrl: string | null;
  websiteSourceId: string | null;
  learnedAt: string | null;
  startedBy: string | null;
  updatedAt: string;
  /** The last "What I learned" card, until applied or re-learned. */
  card?: LearnCard | null;
}

export const ONBOARDING_ACTIONS = ["start", "skip", "resume", "step", "finish", "takeover", "reset"] as const;
export type OnboardingAction = (typeof ONBOARDING_ACTIONS)[number];
export type RescueAction = "takeover" | "reset";

/** An in-progress onboarding with no step for this long may be taken over or reset. */
export const ONBOARDING_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Stuck: in progress, and its starter is no longer a member or nothing has
 * moved for ONBOARDING_STALE_MS.
 */
export function isStuck(state: OnboardingState | null, now: Date, starterIsMember: boolean): boolean {
  if (state?.status !== "in_progress") return false;
  if (!state.startedBy || !starterIsMember) return true;
  return now.getTime() - Date.parse(state.updatedAt) > ONBOARDING_STALE_MS;
}

/**
 * `takeover` (the caller becomes the starter, everything kept) and `reset`
 * (back to not_started, nothing kept). The caller must hold `settings.manage`
 * (checked by the service). The starter may always do either; anyone else
 * only when the onboarding is stuck (409 `onboarding.not_stuck`).
 */
export function rescue(
  state: OnboardingState | null,
  action: RescueAction,
  input: { userId: string; now: Date; starterIsMember: boolean },
): OnboardingState {
  if (state?.status === "done") throw agentError("onboarding.done");
  if (!state || state.status !== "in_progress") throw agentError("onboarding.step_invalid");
  const own = state.startedBy === input.userId;
  if (!own && !isStuck(state, input.now, input.starterIsMember)) throw agentError("onboarding.not_stuck");
  const updatedAt = input.now.toISOString();
  if (action === "takeover") return { ...state, startedBy: input.userId, updatedAt };
  return {
    status: "not_started",
    step: "business",
    businessName: null,
    websiteUrl: null,
    websiteSourceId: null,
    learnedAt: null,
    startedBy: null,
    updatedAt,
    card: null,
  };
}

const STATUSES = new Set(["not_started", "in_progress", "skipped", "done"]);

export function isStep(v: unknown): v is OnboardingStep {
  return typeof v === "string" && (ONBOARDING_STEPS as readonly string[]).includes(v);
}

/** The stored JSON as a state, or null for anything unreadable. */
export function readState(json: unknown): OnboardingState | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const s = json as Partial<OnboardingState>;
  if (!STATUSES.has(String(s.status))) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    status: s.status as OnboardingStatus,
    step: isStep(s.step) ? s.step : "business",
    businessName: str(s.businessName),
    websiteUrl: str(s.websiteUrl),
    websiteSourceId: str(s.websiteSourceId),
    learnedAt: str(s.learnedAt),
    startedBy: str(s.startedBy),
    updatedAt: str(s.updatedAt) ?? new Date(0).toISOString(),
    card: s.card && typeof s.card === "object" ? s.card : null,
  };
}

/** 1..BUSINESS_NAME_MAX characters after trimming (one line), else 400 onboarding.name_invalid. */
export function cleanBusinessName(v: unknown): string {
  const name = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > BUSINESS_NAME_MAX) throw agentError("onboarding.name_invalid", { max: BUSINESS_NAME_MAX });
  return name;
}

/** The starter drives an in-progress onboarding; anyone else gets 409. */
export function assertDriver(state: OnboardingState | null, userId: string): OnboardingState {
  if (state?.status === "done") throw agentError("onboarding.done");
  if (!state || state.status !== "in_progress") throw agentError("onboarding.step_invalid");
  if (state.startedBy && state.startedBy !== userId) throw agentError("onboarding.not_owner");
  return state;
}

export function transition(
  state: OnboardingState | null,
  action: OnboardingAction,
  input: { userId: string; now: Date; step?: unknown; businessName?: unknown },
): OnboardingState {
  if (state?.status === "done") throw agentError("onboarding.done");
  const updatedAt = input.now.toISOString();
  const name = input.businessName === undefined ? undefined : cleanBusinessName(input.businessName);
  switch (action) {
    case "start": {
      if (state?.status === "in_progress") {
        if (state.startedBy && state.startedBy !== input.userId) throw agentError("onboarding.not_owner");
        return name ? { ...state, businessName: name, updatedAt } : state;
      }
      if (state?.status === "skipped") return { ...state, status: "in_progress", startedBy: input.userId, ...(name ? { businessName: name } : {}), updatedAt };
      return {
        status: "in_progress",
        step: name ? "website" : "business",
        businessName: name ?? null,
        websiteUrl: null,
        websiteSourceId: null,
        learnedAt: null,
        startedBy: input.userId,
        updatedAt,
        card: null,
      };
    }
    case "skip": {
      if (state?.status === "skipped") return state;
      const s = assertDriver(state, input.userId);
      return { ...s, status: "skipped", updatedAt };
    }
    case "resume": {
      if (state?.status === "in_progress") return assertDriver(state, input.userId);
      if (state?.status !== "skipped") throw agentError("onboarding.step_invalid");
      return { ...state, status: "in_progress", startedBy: input.userId, updatedAt };
    }
    case "step": {
      const s = assertDriver(state, input.userId);
      if (!isStep(input.step)) throw agentError("onboarding.step_invalid");
      const businessName = name ?? s.businessName;
      if (input.step !== "business" && !businessName) throw agentError("onboarding.name_invalid", { max: BUSINESS_NAME_MAX });
      if (input.step === "learn" && !s.websiteSourceId) throw agentError("onboarding.no_website");
      return { ...s, step: input.step, businessName, updatedAt };
    }
    case "finish": {
      const s = assertDriver(state, input.userId);
      return { ...s, status: "done", step: "live", updatedAt };
    }
    default:
      throw agentError("onboarding.step_invalid");
  }
}
