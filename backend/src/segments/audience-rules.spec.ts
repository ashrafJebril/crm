import { audienceErrorBody } from "./audience-errors";
import {
  AUDIENCE_LIMITS,
  LEGACY_SENTINEL,
  LEGACY_SENTINEL_JSON,
  legacyProjection,
  legacyToTree,
  markRules,
  readRules,
  referencedIds,
  relativeSince,
  rewriteRulesTagName,
  validateRules,
  type AudienceRules,
} from "./audience-rules";

const errOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return audienceErrorBody(e);
  }
  throw new Error("expected a throw");
};

const leaf = (i: number) => ({ field: "tag", op: "has", tag: `t${i}` });

describe("audience rules: legacy reader and projection", () => {
  it("legacyToTree keeps buildWhere's order and drops empties and unknown keys", () => {
    const tree = legacyToTree({
      tagsAny: ["A", "B"],
      tagsAll: ["VIP"],
      stageAny: ["won"],
      hasPhone: false,
      search: "  sara ",
      source: [],
      industry: ["retail"],
      lifecycle: ["lead"],
      ...({ junk: 1 } as object),
    });
    expect(tree).toEqual({
      v: 2,
      op: "and",
      rules: [
        { field: "lifecycle", op: "in", values: ["lead"] },
        { field: "industry", op: "in", values: ["retail"] },
        { field: "name", op: "contains", value: "sara" },
        { field: "phone", op: "unset" },
        { field: "stage_key", op: "in", keys: ["won"] },
        { field: "tag", op: "has", tag: "VIP" },
        { op: "or", rules: [{ field: "tag", op: "has", tag: "A" }, { field: "tag", op: "has", tag: "B" }] },
      ],
    });
    expect(legacyToTree({})).toEqual({ v: 2, op: "and", rules: [] });
    expect(legacyToTree({ search: "   " }).rules).toEqual([]);
  });

  it("readRules prefers rules, else reads the legacy filter", () => {
    const rules: AudienceRules = { v: 2, op: "or", rules: [{ field: "conversations", op: "none" }] };
    expect(readRules({ filter: LEGACY_SENTINEL_JSON, rules })).toEqual({ tree: rules, source: "rules" });
    const legacy = readRules({ filter: '{"lifecycle":["lead"]}', rules: null });
    expect(legacy.source).toBe("legacy");
    expect(legacy.tree.rules).toEqual([{ field: "lifecycle", op: "in", values: ["lead"] }]);
    expect(readRules({ filter: "not json", rules: null }).tree.rules).toEqual([]);
  });

  it("legacyProjection: exact for legacy-expressible trees, null otherwise", () => {
    const f = { lifecycle: ["lead"], tagsAll: ["VIP"], tagsAny: ["A"], hasPhone: true, stageAny: ["x"], search: "s", industry: ["i"], source: ["w"] };
    expect(legacyProjection(legacyToTree(f))).toEqual(f);
    const v2 = (r: unknown): AudienceRules => ({ v: 2, op: "and", rules: [r as never] });
    expect(legacyProjection(v2({ field: "last_active", op: "within", value: { amount: 7, unit: "days" } }))).toBeNull();
    expect(legacyProjection(v2({ field: "lifecycle", op: "not_in", values: ["lead"] }))).toBeNull();
    expect(legacyProjection(v2({ field: "tag", op: "not_has", tag: "VIP" }))).toBeNull();
    expect(legacyProjection(v2({ field: "tag", op: "has", tag: "VIP", missing: true }))).toBeNull();
    expect(legacyProjection({ v: 2, op: "or", rules: [leaf(1), leaf(2)] as never })).toBeNull();
    // Two or-groups cannot both be tagsAny.
    expect(legacyProjection({ v: 2, op: "and", rules: [{ op: "or", rules: [leaf(1)] }, { op: "or", rules: [leaf(2)] }] as never })).toBeNull();
    expect(LEGACY_SENTINEL).toEqual({ stageAny: ["__sp16_rules_v2__"] });
  });
});

describe("rules over the limits are rejected", () => {
  it("31 conditions → rules_too_large {max: 30}", () => {
    const ok = { v: 2, op: "and", rules: Array.from({ length: 30 }, (_, i) => leaf(i)) };
    expect(validateRules(ok).rules).toHaveLength(30);
    const big = { v: 2, op: "and", rules: [{ op: "or", rules: Array.from({ length: 16 }, (_, i) => leaf(i)) }, ...Array.from({ length: 15 }, (_, i) => leaf(i))] };
    expect(errOf(() => validateRules(big))).toMatchObject({ statusCode: 400, message: "audiences.rules_too_large", max: AUDIENCE_LIMITS.maxConditions });
  });

  it("depth 4 → rule_too_deep {max: 3}; depth 3 is accepted", () => {
    const depth3 = { v: 2, op: "and", rules: [{ op: "or", rules: [{ op: "and", rules: [leaf(1)] }] }] };
    expect(() => validateRules(depth3)).not.toThrow();
    const depth4 = { v: 2, op: "and", rules: [{ op: "or", rules: [{ op: "and", rules: [{ op: "or", rules: [leaf(1)] }] }] }] };
    expect(errOf(() => validateRules(depth4))).toMatchObject({ message: "audiences.rule_too_deep", max: 3 });
  });

  it.each([
    ["unknown field", { field: "zodiac", op: "is" }, [0], "unknown_field"],
    ["unknown op", { field: "tag", op: "is", tag: "VIP" }, [0], "bad_op"],
    ["bad RelTime amount", { field: "last_active", op: "within", value: { amount: 0, unit: "days" } }, [0], "bad_reltime"],
    ["bad RelTime unit", { field: "created", op: "within", value: { amount: 3, unit: "years" } }, [0], "bad_reltime"],
    ["fractional RelTime", { field: "created", op: "more_than", value: { amount: 1.5, unit: "days" } }, [0], "bad_reltime"],
    ["bad date", { field: "created", op: "before", date: "2026-02-30" }, [0], "bad_date"],
    ["bad date format", { field: "created", op: "after", date: "01/02/2026" }, [0], "bad_date"],
    ["bad channel", { field: "channel", op: "is", channel: "WhatsApp!" }, [0], "bad_value"],
    ["too many values", { field: "lifecycle", op: "in", values: Array.from({ length: 11 }, (_, i) => `v${i}`) }, [0], "too_many_values"],
    ["empty values", { field: "industry", op: "in", values: [] }, [0], "bad_value"],
    ["bad custom op", { field: "custom_field", op: "between", defId: "d1", value: "1" }, [0], "bad_op"],
    ["missing custom value", { field: "custom_field", op: "eq", defId: "d1" }, [0], "bad_value"],
    ["empty nested group", { op: "or", rules: [] }, [0], "empty_group"],
  ])("%s → invalid_rules {path, reason}", (_name, node, path, reason) => {
    expect(errOf(() => validateRules({ v: 2, op: "and", rules: [node] }))).toMatchObject({
      statusCode: 400,
      message: "audiences.invalid_rules",
      path,
      reason,
    });
  });

  it("reports the nested child-index path", () => {
    const tree = { v: 2, op: "and", rules: [leaf(0), { op: "or", rules: [leaf(1), { field: "tag", op: "nope", tag: "x" }] }] };
    expect(errOf(() => validateRules(tree))).toMatchObject({ path: [1, 1], reason: "bad_op" });
  });

  it("rejects a non-v2 root and normalizes a valid tree", () => {
    expect(errOf(() => validateRules({ op: "and", rules: [] }))).toMatchObject({ reason: "bad_version" });
    expect(errOf(() => validateRules(null))).toMatchObject({ reason: "not_object" });
    const t = validateRules({
      v: 2,
      op: "and",
      rules: [
        { field: "name", op: "contains", value: "  Sara ", uiKey: "x" },
        { field: "pipeline_stage", op: "in", pipelineId: "p1", stageId: "" },
        { field: "tag", op: "has", tag: "VIP", missing: true },
      ],
    });
    expect(t.rules).toEqual([
      { field: "name", op: "contains", value: "Sara" },
      { field: "pipeline_stage", op: "in", pipelineId: "p1" },
      { field: "tag", op: "has", tag: "VIP", missing: true },
    ]);
    expect(validateRules({ v: 2, op: "or", rules: [] })).toEqual({ v: 2, op: "and", rules: [] });
  });
});

describe("audience rules: walking and rewriting", () => {
  const tree: AudienceRules = {
    v: 2,
    op: "and",
    rules: [
      { field: "group", op: "in", segmentId: "s1" },
      { field: "pipeline_stage", op: "not_in", pipelineId: "p1", stageId: "st1" },
      { op: "or", rules: [{ field: "tag", op: "has", tag: "VIP" }, { field: "tag", op: "has", tag: "Gold" }, { field: "custom_field", op: "set", defId: "d1" }] },
      { field: "campaign", op: "replied", campaignId: "c1" },
      { field: "group", op: "not_in", segmentId: "s2", missing: true },
    ],
  };

  it("referencedIds skips missing rules", () => {
    expect(referencedIds(tree)).toEqual({
      segmentIds: ["s1"],
      pipelineIds: ["p1"],
      stageIds: ["st1"],
      defIds: ["d1"],
      campaignIds: ["c1"],
      tagNames: ["VIP", "Gold"],
    });
  });

  it("rewriteRulesTagName renames exact names, dedupes merged siblings, returns null when unchanged", () => {
    const merged = rewriteRulesTagName(tree, "VIP", "Gold")!;
    expect((merged.rules[2] as { rules: unknown[] }).rules).toEqual([
      { field: "tag", op: "has", tag: "Gold" },
      { field: "custom_field", op: "set", defId: "d1" },
    ]);
    expect(rewriteRulesTagName(tree, "VIPER", "X")).toBeNull();
    expect(rewriteRulesTagName(tree, "VIP", "VIP")).toBeNull();
    expect((tree.rules[2] as { rules: unknown[] }).rules).toHaveLength(3); // input untouched
  });

  it("markRules marks matching rules missing and never removes one", () => {
    const { tree: out, marked } = markRules(tree, (r) => r.field === "tag" && r.tag === "VIP");
    expect(marked).toBe(1);
    expect((out.rules[2] as { rules: unknown[] }).rules[0]).toEqual({ field: "tag", op: "has", tag: "VIP", missing: true });
    expect(JSON.stringify(out).length).toBeGreaterThan(JSON.stringify(tree).length);
    expect(markRules(out, (r) => r.field === "tag" && r.tag === "VIP").marked).toBe(0);
  });

  it("relativeSince: hours, days, weeks and calendar months clamped at month ends", () => {
    const now = new Date("2026-03-31T09:00:00.000Z");
    expect(relativeSince(now, { amount: 2, unit: "hours" }).toISOString()).toBe("2026-03-31T07:00:00.000Z");
    expect(relativeSince(now, { amount: 7, unit: "days" }).toISOString()).toBe("2026-03-24T09:00:00.000Z");
    expect(relativeSince(now, { amount: 2, unit: "weeks" }).toISOString()).toBe("2026-03-17T09:00:00.000Z");
    expect(relativeSince(now, { amount: 1, unit: "months" }).toISOString()).toBe("2026-02-28T09:00:00.000Z");
    expect(relativeSince(now, { amount: 2, unit: "months" }).toISOString()).toBe("2026-01-31T09:00:00.000Z");
    expect(relativeSince(new Date("2026-01-31T00:00:00Z"), { amount: 2, unit: "months" }).toISOString()).toBe("2025-11-30T00:00:00.000Z");
    expect(relativeSince(new Date("2024-03-31T00:00:00Z"), { amount: 1, unit: "months" }).toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });
});
