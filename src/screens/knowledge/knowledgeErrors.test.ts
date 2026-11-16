import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
// The backend key lists are the fixture (read as text; never compiled here).
import backendErrors from "../../../backend/src/knowledge-sources/knowledge-errors.ts?raw";
import { KNOWLEDGE_ERROR_COPY, conflictCurrent, cooldownSeconds, knowledgeErrorText, knowledgeKeyText } from "./knowledgeErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

function thrownKeys(): string[] {
  const m = /KNOWLEDGE_ERROR_STATUS = \{([\s\S]*?)\}\s*as const/.exec(backendErrors);
  if (!m) throw new Error("KNOWLEDGE_ERROR_STATUS not found");
  return [...m[1].matchAll(/"(knowledge\.[a-z_]+)"/g)].map((x) => x[1]);
}
function storedKeys(): string[] {
  const m = /KNOWLEDGE_SOURCE_ERRORS = \[([\s\S]*?)\]\s*as const/.exec(backendErrors);
  if (!m) throw new Error("KNOWLEDGE_SOURCE_ERRORS not found");
  return [...m[1].matchAll(/"(knowledge\.[a-z_]+)"/g)].map((x) => x[1]);
}

describe("knowledge error copy covers every SP-21 key in both languages", () => {
  it("the key lists match the backend exactly", () => {
    expect(thrownKeys().length).toBeGreaterThanOrEqual(21);
    expect(storedKeys().length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(KNOWLEDGE_ERROR_COPY).sort()).toEqual([...thrownKeys(), ...storedKeys()].sort());
  });

  it.each([...thrownKeys(), ...storedKeys()])("%s has distinct English and Arabic copy", (key) => {
    const err = new ApiError(key, 400, undefined, { statusCode: 400, message: key });
    const e = knowledgeErrorText(err, en);
    const a = knowledgeErrorText(err, ar);
    expect(e).not.toBe(key);
    expect(e).not.toMatch(ARABIC);
    expect(e).not.toMatch(/Something went wrong/);
    expect(a).toMatch(ARABIC);
    expect(knowledgeKeyText(key, ar)).toMatch(ARABIC);
  });

  it("extras shape the copy: sizes, limits, cooldown, file names; 403 is the shared line", () => {
    const big = new ApiError("knowledge.file_too_large", 413, undefined, { message: "knowledge.file_too_large", maxBytes: 20 * 1024 * 1024 });
    expect(knowledgeErrorText(big, en)).toBe("Each file must be 20 MB or smaller. Nothing was uploaded.");
    const named = new ApiError("x", 400, undefined, { message: "knowledge.file_too_large", maxBytes: 20 * 1024 * 1024, fileName: "menu.pdf" });
    expect(knowledgeErrorText(named, ar)).toBe("الملف menu.pdf أكبر من 20 MB. لم يُرفع أي ملف.");
    const batch = new ApiError("x", 400, undefined, { message: "knowledge.batch_too_large", max: 10 });
    expect(knowledgeErrorText(batch, en)).toBe("Upload at most 10 files at a time. Nothing was uploaded.");
    const cool = new ApiError("x", 409, undefined, { message: "knowledge.cooldown", retryAfterSeconds: 1790 });
    expect(knowledgeErrorText(cool, en)).toBe("You can refresh again in 30 min.");
    expect(cooldownSeconds(cool)).toBe(1790);
    expect(cooldownSeconds(batch)).toBeNull();
    const faq = new ApiError("x", 400, undefined, { message: "knowledge.faq_too_long", field: "answer", max: 2000 });
    expect(knowledgeErrorText(faq, en)).toBe("The answer is too long (up to 2,000 characters).");
    const cols = new ApiError("x", 400, undefined, { message: "knowledge.template_columns", missing: ["valid_to"], unknown: [] });
    expect(knowledgeErrorText(cols, en)).toMatch(/missing required columns: valid_to/);
    expect(knowledgeErrorText(new ApiError("x", 403), ar)).toMatch(ARABIC);
    expect(knowledgeErrorText(new ApiError("x", 403), en)).toMatch(/permission/);
    expect(knowledgeErrorText(new Error("weird"), en)).toBe("Something went wrong. Try again.");
  });

  it("reads the current row of a version conflict", () => {
    const err = new ApiError("x", 409, undefined, { message: "knowledge.version_conflict", current: { id: "s1", version: 3 } });
    expect(conflictCurrent<{ version: number }>(err)).toEqual({ id: "s1", version: 3 });
    expect(conflictCurrent(new ApiError("x", 409, undefined, { message: "knowledge.syncing" }))).toBeNull();
  });
});
