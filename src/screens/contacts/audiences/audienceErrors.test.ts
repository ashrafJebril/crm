import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import type { AudienceRules } from "@/lib/types";
import {
  AUDIENCE_ERROR_COPY,
  INVALID_RULES_REASONS,
  audienceDeleteStateFromError,
  audienceDeleteStateFromRefs,
  audienceErrorText,
  audienceKeyText,
  errorRulePath,
  invalidReasonText,
  isForbidden,
  tagDeleteStateFromError,
  tagDeleteStateFromRefs,
  versionConflict,
} from "./audienceErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;

// Every key in backend segments/audience-errors.ts, tags/tag-errors.ts and the SP-16 campaigns key.
const SP16_KEYS = [
  "audiences.not_found",
  "audiences.reference_not_found",
  "audiences.invalid_rules",
  "audiences.rule_cycle",
  "audiences.rules_too_large",
  "audiences.rule_too_deep",
  "audiences.not_smart",
  "audiences.not_manual",
  "audiences.version_conflict",
  "audiences.in_use",
  "audiences.in_use_by_campaigns",
  "tags.in_use_by_audiences",
  "campaigns.audience_missing",
];

// Every `audiences.invalid_rules` reason (Task 1 report, plus `too_deep` from the I2 fix).
const REASONS = [
  "not_object", "bad_version", "bad_op", "bad_group", "empty_group", "unknown_field",
  "bad_value", "bad_id", "bad_reltime", "bad_date", "too_many_values", "filter_and_rules", "too_deep",
];

const err = (status: number, body: Record<string, unknown>) =>
  new ApiError(String(body.message ?? `HTTP ${status}`), status, undefined, { statusCode: status, ...body });

describe("audience error copy covers every SP-16 key in both languages", () => {
  it("words every key in English and Arabic, never blank and never the raw key", () => {
    expect(Object.keys(AUDIENCE_ERROR_COPY).sort()).toEqual(expect.arrayContaining([...SP16_KEYS].sort()));
    for (const key of SP16_KEYS) {
      const e = audienceKeyText(key, {}, en);
      const a = audienceKeyText(key, {}, ar);
      expect(e, key).toBeTruthy();
      expect(a, key).toBeTruthy();
      expect(e).not.toBe(key);
      expect(a, key).toMatch(ARABIC);
      expect(a, key).not.toBe(e);
    }
  });

  it("words every invalid_rules reason, including too_deep", () => {
    expect([...INVALID_RULES_REASONS].sort()).toEqual([...REASONS].sort());
    for (const reason of REASONS) {
      const e = invalidReasonText(reason, { max: 5 }, en);
      const a = invalidReasonText(reason, { max: 5 }, ar);
      expect(e.trim(), reason).not.toBe("");
      expect(a, reason).toMatch(ARABIC);
      expect(a.replace(/\d/g, ""), reason).not.toMatch(LATIN);
    }
    expect(audienceKeyText("audiences.invalid_rules", { reason: "too_deep", max: 5 }, en)).toMatch(/5/);
    expect(audienceKeyText("audiences.invalid_rules", { reason: "brand_new" }, en)).toBeTruthy();
  });

  it("names the missing reference and the limits", () => {
    expect(audienceKeyText("audiences.reference_not_found", { field: "pipelineId", id: "x" }, en)).toMatch(/pipeline/i);
    expect(audienceKeyText("audiences.reference_not_found", { field: "defId", id: "x" }, en)).toMatch(/field/i);
    expect(audienceKeyText("audiences.rules_too_large", { max: 30 }, en)).toMatch(/30/);
    expect(audienceKeyText("audiences.rule_too_deep", { max: 3 }, en)).toMatch(/3/);
  });

  it("turns errors into text: keys, 403, and unknown messages", () => {
    expect(audienceErrorText(err(400, { message: "audiences.not_smart" }), en)).toBe(audienceKeyText("audiences.not_smart", {}, en));
    expect(audienceErrorText(err(403, { message: "Missing permission" }), ar)).toBe("ليست لديك صلاحية للقيام بذلك");
    expect(isForbidden(err(403, {}))).toBe(true);
    expect(audienceErrorText(new Error("boom"), en)).toBe("Something went wrong. Try again.");
  });

  it("maps a rule error to the offending rule's path", () => {
    const tree: AudienceRules = {
      v: 2,
      op: "and",
      rules: [
        { field: "tag", op: "has", tag: "VIP" },
        { op: "or", rules: [{ field: "group", op: "in", segmentId: "A" }, { field: "custom_field", op: "eq", defId: "D", value: "x" }] },
      ],
    };
    expect(errorRulePath(err(400, { message: "audiences.invalid_rules", path: [1, 1], reason: "bad_value" }), tree)).toEqual([1, 1]);
    expect(errorRulePath(err(404, { message: "audiences.reference_not_found", field: "defId", id: "D" }), tree)).toEqual([1, 1]);
    expect(errorRulePath(err(400, { message: "audiences.rule_cycle", path: ["self", "A", "self"] }), tree)).toEqual([1, 0]);
    expect(errorRulePath(err(400, { message: "audiences.rules_too_large", max: 30 }), tree)).toBeNull();
  });

  it("reads a version conflict's current row", () => {
    const current = { id: "s1", name: "X", version: 4 };
    expect(versionConflict(err(409, { message: "audiences.version_conflict", current }))).toEqual(current);
    expect(versionConflict(err(409, { message: "audiences.in_use" }))).toBeNull();
  });
});

describe("delete dialogs are built from the 409 bodies", () => {
  const A = { id: "a1", name: "Hot", nameAr: "ساخن" };
  const draft = { id: "c1", name: "Promo", status: "draft" };
  const live = { id: "c2", name: "Launch", status: "scheduled" };

  it("audiences.in_use lists both and can be confirmed", () => {
    const s = audienceDeleteStateFromError(err(409, { message: "audiences.in_use", audiences: [A], campaigns: [draft] }));
    expect(s).toEqual({ kind: "in_use", audiences: [A], campaigns: [draft] });
  });

  it("audiences.in_use_by_campaigns blocks with no override", () => {
    const s = audienceDeleteStateFromError(err(409, { message: "audiences.in_use_by_campaigns", campaigns: [live] }));
    expect(s).toEqual({ kind: "blocked", campaigns: [live] });
  });

  it("anything else is not a delete dialog state", () => {
    expect(audienceDeleteStateFromError(err(404, { message: "audiences.not_found" }))).toBeNull();
    expect(audienceDeleteStateFromError(new Error("x"))).toBeNull();
    // a malformed body never crashes
    expect(audienceDeleteStateFromError(err(409, { message: "audiences.in_use", audiences: "nope" }))).toEqual({
      kind: "in_use", audiences: [], campaigns: [],
    });
  });

  it("pre-warns from GET /segments/:id references", () => {
    expect(audienceDeleteStateFromRefs({ audiences: [], campaigns: [] })).toEqual({ kind: "confirm" });
    expect(audienceDeleteStateFromRefs({ audiences: [A], campaigns: [draft] })).toEqual({ kind: "in_use", audiences: [A], campaigns: [draft] });
    expect(audienceDeleteStateFromRefs({ audiences: [A], campaigns: [draft, live, { id: "c3", name: "R", status: "running" }] })).toEqual({
      kind: "blocked",
      campaigns: [live, { id: "c3", name: "R", status: "running" }],
    });
  });

  it("tags.in_use_by_audiences lists the audiences and can be confirmed", () => {
    expect(tagDeleteStateFromError(err(409, { message: "tags.in_use_by_audiences", audiences: [A] }))).toEqual({ kind: "in_use", audiences: [A] });
    expect(tagDeleteStateFromError(err(404, { message: "Tag not found" }))).toBeNull();
    expect(tagDeleteStateFromRefs({ audiences: [] })).toEqual({ kind: "plain" });
    expect(tagDeleteStateFromRefs({ audiences: [A] })).toEqual({ kind: "in_use", audiences: [A] });
  });
});
