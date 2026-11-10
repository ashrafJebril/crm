import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import { TEMPLATE_ERROR_COPY, templateErrorText } from "./templateErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

// Every key in backend templates/template-errors.ts (SP-14 task-2 report).
const KEYS = [
  "templates.not_found",
  "templates.number_invalid",
  "templates.copy_requires_approved",
  "templates.already_on_number",
  "templates.copy_unsupported",
];

describe("template error copy covers every SP-14 key in both languages", () => {
  it("has English and Arabic for each key, and nothing else", () => {
    expect(Object.keys(TEMPLATE_ERROR_COPY).sort()).toEqual([...KEYS].sort());
    for (const key of [...KEYS, "templates.header_media_required"]) {
      const err = new ApiError(key, 400, undefined, { statusCode: 400, message: key });
      const e = templateErrorText(err, en);
      const a = templateErrorText(err, ar);
      expect(e, key).not.toContain(key);
      expect(e, key).not.toBe("Something went wrong. Try again.");
      expect(e, key).not.toMatch(ARABIC);
      expect(a, key).toMatch(ARABIC);
    }
  });

  it("names the status of an existing copy", () => {
    const err = new ApiError("templates.already_on_number", 409, undefined, { status: "paused" });
    expect(templateErrorText(err, en)).toBe("This template is already on that number (paused).");
    expect(templateErrorText(err, ar)).toContain("متوقف مؤقتًا");
  });

  it("uses the shared no-permission copy on 403 and a generic line for unknown errors", () => {
    expect(templateErrorText(new ApiError("Forbidden", 403), en)).toBe("You don't have permission to do this");
    expect(templateErrorText(new ApiError("templates.something_new", 400), en)).toBe("Something went wrong. Try again.");
    expect(templateErrorText(new Error("boom"), ar)).toMatch(ARABIC);
  });
});
