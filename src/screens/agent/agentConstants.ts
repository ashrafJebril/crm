/**
 * SP-20 frontend mirror of backend/src/agent/agent-constants.ts (the values
 * the UI uses). agentConstants.test.ts pins them to the backend file.
 */
export const AGENT_TONES = ["friendly", "professional", "casual", "concise", "enthusiastic", "serious", "witty"] as const;
export type AgentTone = (typeof AGENT_TONES)[number];

export const HOURS_MODES = ["always", "within", "outside"] as const;

export const AGENT_NAME_MAX = 60;
export const GREETING_MAX = 500;
export const EXCLUDED_TAGS_MAX = 50;
export const STOP_REASON_MAX = 500;

export const SANDBOX_MESSAGE_MAX = 1000;
export const SANDBOX_MAX_TURNS = 40;
export const ANSWERED_FROM_VISIBLE = 3;
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

export const ONBOARDING_STEPS = ["business", "website", "learn", "try", "live"] as const;
export const ONBOARDING_STATUSES = ["not_started", "in_progress", "skipped", "done"] as const;
export const BUSINESS_NAME_MAX = 120;
export const LEARN_FAQS_MAX = 20;
export const LEARN_SERVICES_MAX = 30;

/** Tone labels (the plan's copy). */
export const TONE_COPY: Record<AgentTone, [en: string, ar: string]> = {
  friendly: ["Friendly", "ودود"],
  professional: ["Professional", "مهني"],
  casual: ["Casual", "غير رسمي"],
  concise: ["Concise", "موجز"],
  enthusiastic: ["Enthusiastic", "متحمس"],
  serious: ["Serious", "جاد"],
  witty: ["Witty", "ظريف"],
};

export const HOURS_MODE_COPY: Record<(typeof HOURS_MODES)[number], [en: string, ar: string]> = {
  always: ["Always on", "يعمل دائمًا"],
  within: ["Only during working hours", "خلال ساعات العمل فقط"],
  outside: ["Only outside working hours", "خارج ساعات العمل فقط"],
};
