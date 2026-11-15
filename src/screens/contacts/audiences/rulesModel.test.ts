import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import type { AudienceNode, AudienceRule, AudienceRules, RuleIssueKind } from "@/lib/types";
import {
  AUDIENCE_LIMITS,
  FIELD_DEFS,
  RULE_ISSUE_KINDS,
  addGroup,
  addRule,
  canAddGroup,
  canAddRule,
  countConditions,
  countLabel,
  depthOf,
  describeRule,
  describeTree,
  emptyRule,
  isLegacyExpressible,
  isRuleComplete,
  issueText,
  legacyToTree,
  partsText,
  pathOfReference,
  relTimeLabel,
  removeAt,
  replaceAt,
  setGroupOp,
  treeComplete,
  type RuleLookups,
  type RulePart,
} from "./rulesModel";

const en = makeTx("en");
const ar = makeTx("ar");
const LATIN = /[A-Za-z]/;

const lookups: RuleLookups = {
  segments: [
    { id: "g1", name: "VIP group", nameAr: null, origin: "manual" },
    { id: "s1", name: "Hot leads", nameAr: "عملاء ساخنون", origin: "crm" },
  ],
  pipelines: [
    { id: "p1", name: "Sales", nameAr: "المبيعات", archivedAt: null, stages: [{ id: "st1", label: "Won", labelAr: "تم الفوز" }] },
  ],
  defs: [
    { id: "d1", label: "Plan", labelAr: "الخطة", type: "text" },
    { id: "d2", label: "Visits", labelAr: "الزيارات", type: "number" },
    { id: "d3", label: "Renewal", labelAr: "التجديد", type: "date" },
    { id: "d4", label: "Vip", labelAr: "مميز", type: "boolean" },
  ],
  campaigns: [{ id: "c1", name: "Ramadan offer" }],
};

/** Every field with every operator, with values filled in. */
function everyRule(): AudienceRule[] {
  const out: AudienceRule[] = [];
  for (const field of Object.keys(FIELD_DEFS) as AudienceRule["field"][]) {
    for (const op of FIELD_DEFS[field].ops) {
      const r = { ...emptyRule(field), op } as Record<string, unknown>;
      switch (field) {
        case "tag": r.tag = "VIP"; break;
        case "lifecycle": r.values = ["lead", "customer"]; break;
        case "last_active": r.value = { amount: 7, unit: "days" }; break;
        case "channel": r.channel = "whatsapp"; break;
        case "group": r.segmentId = "s1"; break;
        case "created":
          if (op === "before" || op === "after") { delete r.value; r.date = "2026-01-31"; }
          else { delete r.date; r.value = { amount: 3, unit: "months" }; }
          break;
        case "pipeline_stage": r.pipelineId = "p1"; r.stageId = "st1"; break;
        case "custom_field": r.defId = "d2"; if (op !== "set" && op !== "unset") r.value = "4"; break;
        case "campaign": r.campaignId = "c1"; break;
        case "industry": case "source": r.values = ["Retail"]; break;
        case "name": r.value = "Ahmad"; break;
        case "stage_key": r.keys = ["won"]; break;
        default: break;
      }
      out.push(r as AudienceRule);
    }
  }
  return out;
}

describe("legacy filters open in the editor as an and group", () => {
  it("maps each legacy key in buildWhere's order", () => {
    expect(legacyToTree({})).toEqual({ v: 2, op: "and", rules: [] });
    expect(legacyToTree({ lifecycle: ["lead"] }).rules).toEqual([{ field: "lifecycle", op: "in", values: ["lead"] }]);
    expect(legacyToTree({ industry: ["Retail"] }).rules).toEqual([{ field: "industry", op: "in", values: ["Retail"] }]);
    expect(legacyToTree({ source: ["Ads"] }).rules).toEqual([{ field: "source", op: "in", values: ["Ads"] }]);
    expect(legacyToTree({ search: "  ahmad " }).rules).toEqual([{ field: "name", op: "contains", value: "ahmad" }]);
    expect(legacyToTree({ search: "   " }).rules).toEqual([]);
    expect(legacyToTree({ hasPhone: true }).rules).toEqual([{ field: "phone", op: "set" }]);
    expect(legacyToTree({ hasPhone: false }).rules).toEqual([{ field: "phone", op: "unset" }]);
    expect(legacyToTree({ stageAny: ["won"] }).rules).toEqual([{ field: "stage_key", op: "in", keys: ["won"] }]);
    expect(legacyToTree({ tagsAll: ["A", "B"] }).rules).toEqual([
      { field: "tag", op: "has", tag: "A" },
      { field: "tag", op: "has", tag: "B" },
    ]);
    expect(legacyToTree({ tagsAny: ["VIP", "Gold"] }).rules).toEqual([
      { op: "or", rules: [{ field: "tag", op: "has", tag: "VIP" }, { field: "tag", op: "has", tag: "Gold" }] },
    ]);
  });

  it("drops empty arrays and unknown keys as buildWhere does", () => {
    expect(legacyToTree({ lifecycle: [], tagsAny: [], industry: [] } as never)).toEqual({ v: 2, op: "and", rules: [] });
    expect(legacyToTree({ nope: 1 } as never)).toEqual({ v: 2, op: "and", rules: [] });
    expect(legacyToTree(null)).toEqual({ v: 2, op: "and", rules: [] });
  });

  it("describes a legacy filter as one sentence in both languages", () => {
    const tree = legacyToTree({ tagsAny: ["VIP", "Gold"], lifecycle: ["lead"] });
    expect(partsText(describeTree(tree, en, lookups))).toBe("Lifecycle is Lead and (has tag VIP or has tag Gold)");
    expect(partsText(describeTree(tree, ar, lookups))).toBe(
      "مرحلة العميل هي عميل محتمل و(لديه الوسم VIP أو لديه الوسم Gold)",
    );
  });

  it("knows which trees older versions can still read", () => {
    expect(isLegacyExpressible(legacyToTree({ tagsAny: ["VIP", "Gold"], lifecycle: ["lead"] }))).toBe(true);
    expect(isLegacyExpressible({ v: 2, op: "and", rules: [{ field: "conversations", op: "any" }] })).toBe(false);
    expect(isLegacyExpressible({ v: 2, op: "and", rules: [{ field: "tag", op: "has", tag: "A", missing: true }] })).toBe(false);
  });
});

describe("rule sentences cover every field and operator in both languages", () => {
  const rules = everyRule();

  it("has a rule for every field and operator", () => {
    const fields = new Set(rules.map((r) => r.field));
    expect(fields.size).toBe(Object.keys(FIELD_DEFS).length);
    const ops = Object.values(FIELD_DEFS).reduce((n, d) => n + d.ops.length, 0);
    expect(rules.length).toBe(ops);
  });

  it("covers the pipeline-only, multi-value, date and yes/no variants too", () => {
    const extra: AudienceRule[] = [
      { field: "pipeline_stage", op: "in", pipelineId: "p1" },
      { field: "pipeline_stage", op: "not_in", pipelineId: "p1" },
      { field: "pipeline_stage", op: "in", pipelineId: "gone", stageId: "x" },
      { field: "lifecycle", op: "in", values: ["lead"] },
      { field: "lifecycle", op: "not_in", values: ["Mystery"] },
      { field: "custom_field", op: "gt", defId: "d3", value: "2026-02-01" },
      { field: "custom_field", op: "eq", defId: "d4", value: "true" },
      { field: "custom_field", op: "eq", defId: "gone", value: "x" },
      { field: "campaign", op: "read", campaignId: "gone" },
      { field: "channel", op: "is", channel: "telegram" },
      { field: "stage_key", op: "in", keys: ["won", "lost"] },
    ];
    for (const r of extra) {
      const plain = describeRule(r, ar, lookups).filter((p) => !p.bdi).map((p) => p.text).join("");
      expect(plain, JSON.stringify(r)).not.toMatch(LATIN);
    }
  });

  it("never leaks English into the Arabic output, and wraps names for <bdi>", () => {
    for (const r of rules) {
      const parts = describeRule(r, ar, lookups);
      const plain = parts.filter((p) => !p.bdi).map((p) => p.text).join("");
      expect(plain, JSON.stringify(r)).not.toMatch(LATIN);
      expect(plain.trim().length, JSON.stringify(r)).toBeGreaterThan(0);
      const enText = partsText(describeRule(r, en, lookups));
      expect(enText, JSON.stringify(r)).toMatch(LATIN);
      expect(enText).not.toBe(partsText(parts));
    }
  });

  it("puts tag, group, pipeline, field, campaign and value names in <bdi> parts", () => {
    const bdi = (r: AudienceRule, tx = en): string[] => describeRule(r, tx, lookups).filter((p) => p.bdi).map((p) => p.text);
    expect(bdi({ field: "tag", op: "has", tag: "VIP" })).toContain("VIP");
    expect(bdi({ field: "group", op: "in", segmentId: "g1" })).toContain("VIP group");
    expect(bdi({ field: "group", op: "in", segmentId: "s1" }, ar)).toContain("عملاء ساخنون");
    expect(bdi({ field: "name", op: "contains", value: "Ahmad" })).toContain("Ahmad");
    expect(bdi({ field: "campaign", op: "replied", campaignId: "c1" })).toContain("Ramadan offer");
    expect(bdi({ field: "custom_field", op: "eq", defId: "d1", value: "Gold" })).toEqual(expect.arrayContaining(["Plan", "Gold"]));
    expect(bdi({ field: "created", op: "before", date: "2026-01-31" })).toContain("2026-01-31");
  });

  it("words the documented examples", () => {
    expect(partsText(describeRule({ field: "last_active", op: "within", value: { amount: 7, unit: "days" } }, en, lookups))).toBe(
      "Last active within the last 7 days",
    );
    expect(partsText(describeRule({ field: "group", op: "in", segmentId: "g1" }, en, lookups))).toBe("Member of group VIP group");
    expect(partsText(describeRule({ field: "group", op: "in", segmentId: "g1" }, ar, lookups))).toBe("عضو في مجموعة VIP group");
    expect(partsText(describeRule({ field: "group", op: "in", segmentId: "gone" }, en, lookups))).toBe(
      "Member of group (deleted group)",
    );
  });

  it("words relative times with Arabic number agreement", () => {
    expect(relTimeLabel({ amount: 1, unit: "days" }, en)).toBe("1 day");
    expect(relTimeLabel({ amount: 7, unit: "days" }, en)).toBe("7 days");
    expect(relTimeLabel({ amount: 1, unit: "days" }, ar)).toBe("يوم واحد");
    expect(relTimeLabel({ amount: 2, unit: "weeks" }, ar)).toBe("أسبوعين");
    expect(relTimeLabel({ amount: 7, unit: "days" }, ar)).toMatch(/أيام$/);
    expect(relTimeLabel({ amount: 30, unit: "days" }, ar)).toMatch(/يومًا$/);
    expect(relTimeLabel({ amount: 100, unit: "months" }, ar)).toMatch(/شهر$/);
  });
});

describe("editor limits depth and condition count", () => {
  const tag = (t: string): AudienceRule => ({ field: "tag", op: "has", tag: t });

  it("canAddGroup is false at depth 3", () => {
    let tree: AudienceRules = { v: 2, op: "and", rules: [] };
    expect(depthOf(tree)).toBe(1);
    expect(canAddGroup(tree, [])).toBe(true);
    tree = addGroup(tree, []);
    expect(depthOf(tree)).toBe(2);
    expect(canAddGroup(tree, [0])).toBe(true);
    tree = addGroup(tree, [0]);
    expect(depthOf(tree)).toBe(AUDIENCE_LIMITS.maxDepth);
    // the group at [0, 1] is at depth 3: no group inside it
    expect(canAddGroup(tree, [0, 1])).toBe(false);
    expect(canAddRule(tree, [0, 1])).toBe(true);
  });

  it("canAddRule is false at 30", () => {
    let tree: AudienceRules = { v: 2, op: "and", rules: [{ op: "or", rules: [tag("x")] }] };
    for (let i = 0; i < 29; i++) tree = replaceAt(addRule(tree, []), [tree.rules.length], tag(`t${i}`));
    expect(countConditions(tree)).toBe(AUDIENCE_LIMITS.maxConditions);
    expect(canAddRule(tree, [])).toBe(false);
    expect(canAddRule(tree, [0])).toBe(false);
    expect(canAddGroup(tree, [])).toBe(false);
  });

  it("edits immutably and prunes emptied groups", () => {
    const tree: AudienceRules = { v: 2, op: "and", rules: [tag("a"), { op: "or", rules: [tag("b")] }] };
    const next = removeAt(tree, [1, 0]);
    expect(next.rules).toEqual([tag("a")]);
    expect(tree.rules).toHaveLength(2);
    expect(setGroupOp(tree, [1], "and").rules[1]).toEqual({ op: "and", rules: [tag("b")] });
    expect(setGroupOp(tree, [], "or").op).toBe("or");
    const withGroup = addGroup(tree, []);
    expect((withGroup.rules[2] as { rules: AudienceNode[] }).rules).toHaveLength(1);
  });

  it("knows when a rule still needs a value", () => {
    expect(isRuleComplete(emptyRule("tag"))).toBe(false);
    expect(isRuleComplete({ field: "tag", op: "has", tag: "VIP" })).toBe(true);
    expect(isRuleComplete(emptyRule("conversations"))).toBe(true);
    expect(isRuleComplete({ field: "custom_field", op: "set", defId: "d1" })).toBe(true);
    expect(isRuleComplete({ field: "custom_field", op: "eq", defId: "d1", value: "" })).toBe(false);
    expect(treeComplete({ op: "and", rules: [{ op: "or", rules: [emptyRule("group")] }] })).toBe(false);
  });

  it("finds the rule a server reference error points at", () => {
    const tree: AudienceRules = {
      v: 2,
      op: "and",
      rules: [tag("a"), { op: "or", rules: [{ field: "group", op: "in", segmentId: "zz" }] }],
    };
    expect(pathOfReference(tree, "segmentId", "zz")).toEqual([1, 0]);
    expect(pathOfReference(tree, "defId", "zz")).toBeNull();
  });
});

describe("issues render in both languages and never as blank", () => {
  it("covers every RuleIssue.kind", () => {
    const kinds: RuleIssueKind[] = [
      "tag_deleted", "group_missing", "field_missing", "pipeline_missing",
      "pipeline_archived", "stage_missing", "campaign_missing", "cycle", "too_deep",
    ];
    expect([...RULE_ISSUE_KINDS].sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      const e = issueText({ path: [0], kind }, en);
      const a = issueText({ path: [0], kind }, ar);
      expect(e.trim(), kind).not.toBe("");
      expect(a.trim(), kind).not.toBe("");
      expect(a, kind).not.toMatch(LATIN);
      expect(a).not.toBe(e);
    }
  });

  it("falls back to a worded message for an unknown kind", () => {
    const t = issueText({ path: [], kind: "brand_new" as RuleIssueKind }, en);
    expect(t.trim()).not.toBe("");
  });
});

describe("timed-out count never renders as zero", () => {
  it("words null counts and never shows 0 or a blank for them", () => {
    const timed = countLabel(null, true, en);
    expect(timed.text).toBe("Too large to count right now");
    expect(timed.state).toBe("too_large");
    expect(countLabel(null, true, ar).text).toBe("العدد كبير جدًا لحسابه الآن");
    const pending = countLabel(null, false, en);
    expect(pending.text).toBe("Counting…");
    expect(countLabel(null, undefined, ar).text).toBe("جارٍ العدّ…");
    for (const l of [timed, pending, countLabel(undefined, false, en)]) {
      expect(l.text).not.toMatch(/^0$/);
      expect(l.short).not.toBe("0");
      expect(l.text.trim()).not.toBe("");
      expect(l.short.trim()).not.toBe("");
    }
  });

  it("formats a known count, including a real zero", () => {
    expect(countLabel(0, false, en)).toMatchObject({ text: "0", short: "0", state: "known" });
    expect(countLabel(1234, true, en).text).toBe((1234).toLocaleString("en-US"));
  });
});

describe("rule parts", () => {
  it("joins parts into plain text", () => {
    const parts: RulePart[] = [{ text: "Has tag " }, { text: "VIP", bdi: true }];
    expect(partsText(parts)).toBe("Has tag VIP");
  });
});
