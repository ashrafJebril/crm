/**
 * SP-18 mirror of backend/src/copilot/copilot-constants.ts (the client's
 * checks and limits). copilotConstants.test.ts pins every value to the backend file.
 */
import type { CopilotApprovalMode } from "@/lib/types";

export const APPROVAL_MODES: readonly CopilotApprovalMode[] = ["manual", "agent_decides", "auto"];
export const DEFAULT_APPROVAL_MODE: CopilotApprovalMode = "manual";
export const AUTO_APPLY_TOOLS = ["create_activity", "move_ticket_stage"] as const;
export const REF_KINDS = ["contact", "ticket", "booking"] as const;
export const MAX_REFS = 5;
export const MESSAGE_MAX = 4000;
export const FEEDBACK_MAX = 2000;
export const TITLE_MAX = 60;
export const HISTORY_PAGE = 20;
export const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ACTION_TTL_MS = 30 * 60 * 1000;

export const ATTACH_MAX_PER_MESSAGE = 5;
export const ATTACH_DOC_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACH_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACH_TYPES = ["pdf", "csv", "xlsx", "txt", "jpeg", "png", "webp"] as const;

export const STREAM_EVENTS = ["session", "activity", "token", "confirm", "receipt", "draft", "sources", "done", "error"] as const;

/** While a turn is running server-side and the stream was lost, re-read the session this often. */
export const RESUME_POLL_MS = 2500;
