import { describe, expect, it } from "vitest";
// The backend file is the fixture (read as text; never compiled here).
import backendConstants from "../../../backend/src/agent/agent-constants.ts?raw";
import * as mine from "./agentConstants";

/** `export const NAME = <number | ["..."] as const>;` → its value. */
function backendValue(name: string): unknown {
  const m = new RegExp(`export const ${name} = ([\\s\\S]+?);\\n`).exec(backendConstants.replace(/\r\n/g, "\n"));
  if (!m) throw new Error(`${name} not found in the backend constants`);
  const expr = m[1].replace(/ as const$/, "").trim();
  if (expr.startsWith("[")) return [...expr.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (!/^[\d_ *]+$/.test(expr)) throw new Error(`${name}: unexpected expression ${expr}`);
  return expr
    .replace(/_/g, "")
    .split("*")
    .map((n) => Number(n.trim()))
    .reduce((a, b) => a * b, 1);
}

const SHARED = [
  "AGENT_TONES",
  "HOURS_MODES",
  "AGENT_NAME_MAX",
  "GREETING_MAX",
  "EXCLUDED_TAGS_MAX",
  "STOP_REASON_MAX",
  "SANDBOX_MESSAGE_MAX",
  "SANDBOX_MAX_TURNS",
  "ANSWERED_FROM_VISIBLE",
  "SANDBOX_READ_TOOLS",
  "ONBOARDING_STEPS",
  "ONBOARDING_STATUSES",
  "BUSINESS_NAME_MAX",
  "LEARN_FAQS_MAX",
  "LEARN_SERVICES_MAX",
] as const;

describe("agent constants mirror the backend", () => {
  it.each(SHARED)("%s", (name) => {
    expect((mine as Record<string, unknown>)[name]).toEqual(backendValue(name));
  });

  it("every tone and hours mode has English and Arabic copy", () => {
    for (const t of mine.AGENT_TONES) expect(mine.TONE_COPY[t][1]).toMatch(/[؀-ۿ]/);
    for (const m of mine.HOURS_MODES) expect(mine.HOURS_MODE_COPY[m][1]).toMatch(/[؀-ۿ]/);
    expect(mine.AGENT_TONES).not.toContain("sarcastic");
  });
});
