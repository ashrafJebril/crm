import { AGENT_ERROR_KEYS, AGENT_ERROR_STATUS, agentError } from "./agent-errors";

describe("SP-20 agent errors", () => {
  it("lists every key of the plan with its status", () => {
    expect(AGENT_ERROR_STATUS).toEqual({
      "agent.name_required": 400,
      "agent.tone_invalid": 400,
      "agent.tag_unknown": 400,
      "agent.message_invalid": 400,
      "onboarding.name_invalid": 400,
      "onboarding.step_invalid": 400,
      "agent.not_found": 404,
      "agent.version_conflict": 409,
      "onboarding.not_owner": 409,
      "onboarding.done": 409,
      "onboarding.no_website": 409,
      "onboarding.not_learned": 409,
      "agent.hours_invalid": 422,
      "agent.hours_empty": 422,
      "agent.sandbox_rate": 429,
      "agent.ai_unavailable": 503,
      "onboarding.ai_unavailable": 503,
      "agent.ai_failed": 502,
      "agent.resync_failed": 502,
      "onboarding.ai_failed": 502,
    });
    expect(AGENT_ERROR_KEYS).toHaveLength(20);
  });

  it("builds {statusCode, message: key, ...extra}", () => {
    const e = agentError("agent.version_conflict", { current: 3 });
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({ statusCode: 409, message: "agent.version_conflict", current: 3 });
    expect(agentError("agent.hours_invalid", { day: "mon", reason: "overlap" }).getResponse()).toEqual({
      statusCode: 422,
      message: "agent.hours_invalid",
      day: "mon",
      reason: "overlap",
    });
  });
});
