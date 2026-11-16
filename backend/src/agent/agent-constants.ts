/**
 * SP-20 agent constants (Global Constraints → Constants). The frontend mirror
 * `src/screens/agent/agentConstants.ts` (Task 3) is pinned to these values by
 * a test.
 */

/** Tkana's tone list without `sarcastic` (ruling 8). */
export const AGENT_TONES = ["friendly", "professional", "casual", "concise", "enthusiastic", "serious", "witty"] as const;
export type AgentTone = (typeof AGENT_TONES)[number];

/** `always` (default): reply any time; `within`: only inside the weekly schedule; `outside`: only outside it. */
export const HOURS_MODES = ["always", "within", "outside"] as const;
export type HoursMode = (typeof HOURS_MODES)[number];

export const PUBLISH_STATES = ["none", "pending", "published", "failed"] as const;
export type PublishState = (typeof PUBLISH_STATES)[number];

export const AGENT_NAME_MAX = 60;
export const GREETING_MAX = 500;
export const EXCLUDED_TAGS_MAX = 50;
export const STOP_REASON_MAX = 500;

/** The reply gate re-reads a workspace's settings at most this often (per process). */
export const AGENT_GATE_CACHE_MS = 30_000;
/** The l prompt block that carries the persona (SP-21 `prompt-blocks.ts`). */
export const PERSONA_BLOCK = "persona";

// ── Sandbox (Task 2) ───────────────────────────────────────────────────
export const SANDBOX_MESSAGE_MAX = 1000;
export const SANDBOX_MAX_TURNS = 40;
export const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000;
export const SANDBOX_RATE = { turns: 20, windowMs: 10 * 60 * 1000 } as const;
export const SANDBOX_TIMEOUT_MS = 90_000;
export const SANDBOX_MAX_ITERATIONS = 6;
export const SANDBOX_MAX_TOOL_CALLS = 8;
export const ANSWERED_FROM_VISIBLE = 3;
/** Deny by default: only these tool ids execute for real in the sandbox. */
export const SANDBOX_READ_TOOLS = [
  "list_appointments",
  "get_appointment",
  "list_services",
  "find_slots",
  "search_contacts",
  "get_contact",
  "list_photos",
  "search_knowledge",
] as const;

// ── Onboarding (Task 2) ────────────────────────────────────────────────
export const ONBOARDING_STEPS = ["business", "website", "learn", "try", "live"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const ONBOARDING_STATUSES = ["not_started", "in_progress", "skipped", "done"] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];
export const BUSINESS_NAME_MAX = 120;
export const LEARN_PAGES_MAX = 20;
export const LEARN_TEXT_MAX = 60_000;
export const LEARN_FAQS_MAX = 20;
export const LEARN_SERVICES_MAX = 30;
