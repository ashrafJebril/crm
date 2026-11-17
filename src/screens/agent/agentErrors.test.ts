import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
// The backend files are the fixtures (read as text; never compiled here).
import backendErrors from "../../../backend/src/agent/agent-errors.ts?raw";
import backendAuth from "../../../backend/src/auth/auth.controller.ts?raw";
import { AGENT_ERROR_COPY, agentErrorText, agentKeyText, conflictVersion } from "./agentErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

function agentKeys(): string[] {
  const m = /AGENT_ERROR_STATUS = \{([\s\S]*?)\}\s*as const/.exec(backendErrors);
  if (!m) throw new Error("AGENT_ERROR_STATUS not found");
  return [...m[1].matchAll(/"((?:agent|onboarding)\.[a-z_]+)"/g)].map((x) => x[1]);
}
function authKeys(): string[] {
  return [...new Set([...backendAuth.matchAll(/message: "(auth\.[a-z_]+)"/g)].map((x) => x[1]))];
}

describe("agent error copy covers every SP-20 key in both languages", () => {
  it("the key list matches the backend exactly (agent, onboarding and the signup limiter)", () => {
    expect(agentKeys().length).toBeGreaterThanOrEqual(21);
    expect(agentKeys()).toEqual(expect.arrayContaining(["agent.resync_failed", "onboarding.not_stuck"]));
    expect(authKeys()).toEqual(["auth.register_rate"]);
    expect(Object.keys(AGENT_ERROR_COPY).sort()).toEqual([...agentKeys(), ...authKeys()].sort());
  });

  it.each([...agentKeys(), ...authKeys()])("%s has distinct English and Arabic copy", (key) => {
    const err = new ApiError(key, 400, undefined, { statusCode: 400, message: key });
    const e = agentErrorText(err, en);
    const a = agentErrorText(err, ar);
    expect(e).not.toBe(key);
    expect(e).not.toMatch(ARABIC);
    expect(e).not.toMatch(/Something went wrong/);
    expect(a).toMatch(ARABIC);
  });

  it("uses the extras", () => {
    expect(agentKeyText("agent.sandbox_rate", en, { retryAfterSeconds: 125 })).toContain("3 minutes");
    expect(agentKeyText("agent.hours_invalid", en, { day: "mon", reason: "overlap" })).toMatch(/^Mon/);
    expect(agentKeyText("auth.register_rate", ar, { retryAfterSeconds: 60 })).toMatch(ARABIC);
    expect(conflictVersion(new ApiError("x", 409, undefined, { message: "agent.version_conflict", current: 7 }))).toBe(7);
    expect(agentErrorText(new ApiError("Forbidden", 403), en)).toMatch(/permission/);
    expect(agentErrorText(new Error("boom"), en)).toMatch(/Something went wrong/);
  });
});
