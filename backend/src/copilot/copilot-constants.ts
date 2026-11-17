/**
 * SP-18 copilot constants (Global Constraints → Constants). The frontend
 * mirror `src/copilot/copilotConstants.ts` (Task 3) is pinned to these
 * values by a test.
 */

export const APPROVAL_MODES = ["manual", "agent_decides", "auto"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "manual";
/** Auto mode applies only these (move_ticket_stage only for a non-terminal target; Task 2). */
export const AUTO_APPLY_TOOLS = ["create_activity", "move_ticket_stage"] as const;

export const REF_KINDS = ["contact", "ticket", "booking"] as const;
export type RefKind = (typeof REF_KINDS)[number];
export const MAX_REFS = 5;

export const PAGE_KEYS = [
  "dashboard",
  "inbox",
  "conversation",
  "contacts",
  "contact",
  "pipeline",
  "ticket",
  "calendar",
  "booking",
  "followups",
  "campaigns",
  "campaign",
  "agent",
  "knowledge",
  "insights_support",
  "insights_sales",
  "other",
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export const MESSAGE_MAX = 4000;
export const MAX_ITERATIONS = 6;
export const MAX_TOOL_CALLS = 10;
export const CALL_TIMEOUT_MS = 120_000;
export const TURN_BUDGET_MS = 300_000;
export const HEARTBEAT_MS = 15_000;
export const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ACTION_TTL_MS = 30 * 60 * 1000;
export const FEEDBACK_MAX = 2000;
export const TITLE_MAX = 60;
export const HISTORY_PAGE = 20;
/** Turns replayed verbatim; older ones are dropped with a note (ruling 8). */
export const TRANSCRIPT_TURNS_SENT = 20;

export const ATTACH_MAX_PER_MESSAGE = 5;
export const ATTACH_DOC_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACH_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACH_TEXT_MAX = 200_000;
export const ATTACH_TYPES = ["pdf", "csv", "xlsx", "txt", "jpeg", "png", "webp"] as const;
export const ATTACH_UNSENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Per member (ruling 9); env COPILOT_RATE_TURNS overrides the count. */
export const COPILOT_RATE = { turns: 30, windowMs: 10 * 60 * 1000 } as const;
/** Per workspace per UTC day (ruling 9); env COPILOT_DAILY_TURNS overrides. */
export const COPILOT_DAILY_TURNS = 300;

/** Source cards per answer. */
export const SOURCES_MAX = 8;
/** Characters of one tool result sent back to the model. */
export const TOOL_RESULT_MAX = 30_000;
/** The persona the copilot runs as today (a registry key for later personas). */
export const COPILOT_PERSONA = "aida";

export const COPILOT_MODEL_ENV = "COPILOT_MODEL";
export const COPILOT_TITLE_MODEL_ENV = "COPILOT_TITLE_MODEL";
export const CHAT_MAX_TOKENS = 64_000;
export const TITLE_MAX_TOKENS = 16_000;

/** Stream event names (the protocol Task 3's client parses). */
export const STREAM_EVENTS = ["session", "activity", "token", "confirm", "receipt", "draft", "sources", "done", "error"] as const;
export type StreamEventName = (typeof STREAM_EVENTS)[number];
