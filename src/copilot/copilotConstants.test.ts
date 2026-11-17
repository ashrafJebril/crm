import { describe, expect, it } from "vitest";
// The backend file is the fixture (read as text; never compiled here).
import backend from "../../backend/src/copilot/copilot-constants.ts?raw";
import * as C from "./copilotConstants";

/** Evaluate a simple numeric constant expression of the backend file (digits, _, *, +). */
function num(name: string): number {
  const m = new RegExp(`export const ${name} = ([0-9_ *+]+);`).exec(backend);
  if (!m) throw new Error(`${name} not found`);
  return m[1]
    .split("+")
    .map((t) => t.split("*").reduce((acc, x) => acc * Number(x.trim().replace(/_/g, "")), 1))
    .reduce((a, b) => a + b, 0);
}
function list(name: string): string[] {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(backend);
  if (!m) throw new Error(`${name} not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("copilot constants mirror the backend", () => {
  it.each([
    "MAX_REFS",
    "MESSAGE_MAX",
    "FEEDBACK_MAX",
    "TITLE_MAX",
    "HISTORY_PAGE",
    "RESUME_WINDOW_MS",
    "ACTION_TTL_MS",
    "ATTACH_MAX_PER_MESSAGE",
    "ATTACH_DOC_MAX_BYTES",
    "ATTACH_IMAGE_MAX_BYTES",
  ] as const)("%s", (name) => {
    expect(C[name]).toBe(num(name));
  });

  it("lists", () => {
    expect([...C.APPROVAL_MODES]).toEqual(list("APPROVAL_MODES"));
    expect([...C.AUTO_APPLY_TOOLS]).toEqual(list("AUTO_APPLY_TOOLS"));
    expect([...C.REF_KINDS]).toEqual(list("REF_KINDS"));
    expect([...C.ATTACH_TYPES]).toEqual(list("ATTACH_TYPES"));
    expect([...C.STREAM_EVENTS]).toEqual(list("STREAM_EVENTS"));
    expect(C.DEFAULT_APPROVAL_MODE).toBe("manual");
  });
});
