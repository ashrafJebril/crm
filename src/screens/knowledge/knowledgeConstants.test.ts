import { describe, expect, it } from "vitest";
// The backend file is the fixture (read as text; never compiled here).
import backendConstants from "../../../backend/src/knowledge-sources/knowledge-constants.ts?raw";
import * as mine from "./knowledgeConstants";

/** `export const NAME = <arithmetic>;` or `= [..] as const;` → its value. */
function backendValue(name: string): unknown {
  const m = new RegExp(`export const ${name} = ([^;]+);`).exec(backendConstants);
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
  "KNOWLEDGE_KINDS",
  "KNOWLEDGE_STATUSES",
  "PAGE_STATES",
  "SCHEDULES",
  "TYPED_KINDS",
  "FAQ_QUESTION_MAX",
  "FAQ_ANSWER_MAX",
  "FAQ_MAX",
  "GUIDELINES_MAX",
  "KNOWLEDGE_CONTENT_MAX",
  "KB_FILE_MAX_BYTES",
  "KB_BATCH_MAX",
  "KB_FILE_TYPES",
  "MAX_TYPED_ROWS",
  "MAX_ROW_ERRORS_REPORTED",
  "WEBSITE_MAX_SOURCES",
  "WEBSITE_PAGE_CAP",
  "REFRESH_COOLDOWN_MS",
  "MAX_CONSECUTIVE_FAILURES",
  "PREVIEW_MAX_ITEMS",
] as const;

describe("knowledge constants", () => {
  it.each(SHARED)("constants equal the backend's: %s", (name) => {
    expect((mine as Record<string, unknown>)[name]).toEqual(backendValue(name));
  });

  it("the picker accepts exactly the backend's file types", () => {
    const ext = mine.KB_EXTENSIONS.map((e) => (e === "jpg" ? "jpeg" : e));
    expect([...new Set(ext)].sort()).toEqual([...mine.KB_FILE_TYPES].sort());
    expect(mine.KB_ACCEPT.split(",").map((x) => x.slice(1))).toEqual([...mine.KB_EXTENSIONS]);
  });
});
