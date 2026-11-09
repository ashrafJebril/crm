import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import { FAILURE_LABELS, failureLabel, isShortTitle, unrecordedLabel } from "./failureCodes";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

// The full list from the SP-12 task-2 report ("Failure codes T3 must label").
const CODES = [
  "skip:opted_out",
  "skip:no_phone",
  "provider:unknown",
  ...[
    131026, 131047, 131049, 131050, 131056, 131048, 131042, 131031, 131051, 131052, 131053, 132000, 132001, 132015,
    132016, 130472, 131000, 368,
  ].map((n) => `meta:${n}`),
];

describe("failureLabel", () => {
  it("failureLabel covers skip, provider and known meta codes in both languages and falls back for unknown", () => {
    expect(Object.keys(FAILURE_LABELS).sort()).toEqual([...CODES].sort());
    for (const code of CODES) {
      const e = failureLabel(code, null, en);
      const a = failureLabel(code, null, ar);
      expect(e, code).toBeTruthy();
      expect(e, code).not.toMatch(ARABIC);
      expect(a, code).toMatch(ARABIC);
      expect(e, code).not.toContain(code);
    }
    expect(failureLabel("meta:999999", null, en)).toBe("WhatsApp error 999999");
    expect(failureLabel("meta:999999", null, ar)).toBe("خطأ واتساب 999999");
  });

  it("mirrors the backend CSV copy for the canonical codes", () => {
    expect(failureLabel("meta:131026", null, en)).toBe("Message undeliverable");
    expect(failureLabel("meta:131026", null, ar)).toBe("تعذر توصيل الرسالة");
    expect(failureLabel("skip:opted_out", null, en)).toBe("Opted out of marketing");
  });

  it("appends a short title to unknown meta codes and provider:unknown only", () => {
    expect(failureLabel("meta:4242", "Rate limited", en)).toBe("WhatsApp error 4242: Rate limited");
    expect(failureLabel("provider:unknown", "Timeout", en)).toBe("Provider error: Timeout");
    expect(failureLabel("provider:unknown", "Timeout", ar)).toBe("خطأ من مزوّد الخدمة: Timeout");
    // Known codes keep their own copy: the provider text is not shown.
    expect(failureLabel("meta:131026", "Undeliverable", en)).toBe("Message undeliverable");
  });

  it("never renders a long or structured provider text", () => {
    expect(failureLabel("meta:4242", '{"error":1}', en)).toBe("WhatsApp error 4242");
    expect(failureLabel("meta:4242", "x".repeat(121), en)).toBe("WhatsApp error 4242");
    expect(failureLabel("meta:4242", "two\nlines", en)).toBe("WhatsApp error 4242");
    expect(isShortTitle("x".repeat(120))).toBe(true);
    expect(isShortTitle("   ")).toBe(false);
  });

  it("labels unknown skip reasons and other namespaces without crashing", () => {
    expect(failureLabel("skip:duplicate", null, en)).toBe("Left out (duplicate)");
    expect(failureLabel("skip:duplicate", null, ar)).toMatch(ARABIC);
    expect(failureLabel("other:x", null, en)).toBe("other:x");
    expect(failureLabel(null, null, en)).toBe("");
  });

  it("has an unrecorded label in both languages", () => {
    expect(unrecordedLabel(en)).toBe("Reason not recorded");
    expect(unrecordedLabel(ar)).toMatch(ARABIC);
  });
});
