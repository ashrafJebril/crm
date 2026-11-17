import { HttpException } from "@nestjs/common";

/**
 * SP-20 error keys (Global Constraints → Error keys). The response body is
 * `{statusCode, message: key, ...extra}`; the frontend maps the key through
 * `tx` (`src/screens/agent/agentErrors.ts`, Task 3).
 */
export const AGENT_ERROR_STATUS = {
  "agent.name_required": 400,
  "agent.tone_invalid": 400,
  "agent.tag_unknown": 400,
  "agent.message_invalid": 400,
  "onboarding.name_invalid": 400,
  "onboarding.step_invalid": 400,
  "agent.not_found": 404,
  "agent.version_conflict": 409, // {current}
  "onboarding.not_owner": 409,
  "onboarding.done": 409,
  "onboarding.no_website": 409,
  "onboarding.not_learned": 409,
  "agent.hours_invalid": 422, // {day, reason}
  "agent.hours_empty": 422,
  "agent.sandbox_rate": 429, // {retryAfterSeconds}
  "agent.ai_unavailable": 503,
  "onboarding.ai_unavailable": 503,
  "agent.ai_failed": 502,
  "agent.resync_failed": 502, // review: the agent platform refused or was unreachable on "Re-sync"
  "onboarding.ai_failed": 502,
} as const;

export type AgentErrorKey = keyof typeof AGENT_ERROR_STATUS;
export const AGENT_ERROR_KEYS = Object.keys(AGENT_ERROR_STATUS) as AgentErrorKey[];

export function agentError(key: AgentErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = AGENT_ERROR_STATUS[key];
  return new HttpException({ statusCode, message: key, ...extra }, statusCode);
}
