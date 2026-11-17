import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import backendErrors from "../../../../backend/src/lifecycle/lifecycle-errors.ts?raw";
import { LIFECYCLE_ERROR_COPY, isSystemLocked, lifecycleErrorText } from "./lifecycleErrors";

const ARABIC = /[؀-ۿ]/;
const ARABIC_DIGITS = /[٠-٩]/;
const en = makeTx("en");
const ar = makeTx("ar");

describe("lifecycle error copy covers every SP-24 key in both languages", () => {
  it("the key list equals the backend's STATUS record", () => {
    const status = /const STATUS[^{]*\{([^}]*)\}/.exec(backendErrors)![1];
    const keys = [...status.matchAll(/"([a-z_]+\.[a-z_]+)":/g)].map((m) => m[1]);
    expect(keys.length).toBe(8);
    expect(keys).toContain("workflows.system_locked");
    expect(Object.keys(LIFECYCLE_ERROR_COPY).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      const e = new ApiError(k, 409, undefined, { statusCode: 409, message: k });
      expect(lifecycleErrorText(e, en)).not.toMatch(ARABIC);
      expect(lifecycleErrorText(e, en)).not.toBe(k);
      expect(lifecycleErrorText(e, ar)).toMatch(ARABIC);
      expect(lifecycleErrorText(e, ar)).not.toMatch(ARABIC_DIGITS);
    }
  });

  it("extras: offset bounds, rejected language and reason, missing language", () => {
    const offset = new ApiError("lifecycle.invalid_offset", 400, undefined, { message: "lifecycle.invalid_offset", min: 60, max: 10080 });
    expect(lifecycleErrorText(offset, en)).toBe("Choose a reminder between 1 hour and 1 week before the booking.");
    expect(lifecycleErrorText(offset, ar)).toBe("اختر تذكيرًا بين ساعة وأسبوع قبل الحجز.");
    const rej = new ApiError("lifecycle.template_rejected", 409, undefined, { message: "x", language: "en", reason: "INVALID_FORMAT" });
    expect(lifecycleErrorText(rej, en)).toContain("English");
    expect(lifecycleErrorText(rej, en)).toContain("INVALID_FORMAT");
    const miss = new ApiError("lifecycle.template_missing", 409, undefined, { message: "x", language: "ar" });
    expect(lifecycleErrorText(miss, ar)).toContain("العربية");
  });

  it("403 is the shared no-permission line; system_locked is recognised", () => {
    expect(lifecycleErrorText(new ApiError("Forbidden", 403), en)).toMatch(/permission/);
    expect(isSystemLocked(new ApiError("workflows.system_locked", 409))).toBe(true);
    expect(isSystemLocked(new ApiError("other", 409))).toBe(false);
    expect(lifecycleErrorText(new Error("boom"), en)).toBe("Something went wrong. Try again.");
  });
});
