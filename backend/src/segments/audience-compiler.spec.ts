import { compileAudience, MATCH_NONE } from "./audience-compiler";
import { loadLookups, type LookupsPrisma } from "./audience-lookups";
import { AUDIENCE_LIMITS, legacyProjection, legacyToTree, readRules, type AudienceNode, type AudienceRules, type SegmentFilter } from "./audience-rules";
import { createAudienceDb, evaluateContacts, type AudienceTables } from "./audience-test-db";
import { legacyBuildWhere, legacyParseFilter } from "./__fixtures__/legacy-build-where";
import { legacyWorld, NOW, predicateWorld, seg, WS } from "./__fixtures__/audience-world";
import { SegmentsService } from "./segments.service";

async function compileIn(t: AudienceTables, tree: AudienceRules, now = NOW) {
  const { prisma } = createAudienceDb(t);
  const lookups = await loadLookups(prisma as unknown as LookupsPrisma, WS, [tree]);
  return compileAudience(WS, tree, { now, tz: lookups.timezone, lookups, visited: new Set(), depth: 0 });
}

describe("legacy filter JSON evaluates identically", () => {
  const t = legacyWorld();
  const wsIds = t.contact.filter((c) => c.workspaceId === WS).map((c) => c.id).sort();

  const FILTERS: Array<[string, SegmentFilter | string]> = [
    ["empty object", {}],
    ["lifecycle lead (case-insensitive)", { lifecycle: ["lead"] }],
    ["lifecycle Lead + churned", { lifecycle: ["Lead", "churned"] }],
    ["lifecycle empty array", { lifecycle: [] }],
    ["industry", { industry: ["retail"] }],
    ["source two values", { source: ["wa", "web"] }],
    ["source case-sensitive", { source: ["referral"] }],
    ["search mixed case", { search: "sara" }],
    ["search spaces only", { search: "   " }],
    ["search Arabic with spaces", { search: " محمد " }],
    ["hasPhone true", { hasPhone: true }],
    ["hasPhone false", { hasPhone: false }],
    ["stageAny won across pipelines", { stageAny: ["won"] }],
    ["stageAny new + lost", { stageAny: ["new", "lost"] }],
    ["tagsAll VIP (not VIPER)", { tagsAll: ["VIP"] }],
    ["tagsAll VIPER", { tagsAll: ["VIPER"] }],
    ["tagsAny VIPER or Gold", { tagsAny: ["VIPER", "Gold"] }],
    ["tagsAll + tagsAny", { tagsAll: ["VIP"], tagsAny: ["Riyadh, KSA", "Gold"] }],
    ["tag with a comma", { tagsAll: ["Riyadh, KSA"] }],
    ["tag prefix of another", { tagsAny: ["Riyadh"] }],
    ["combination", { lifecycle: ["lead"], industry: ["retail", "food"], hasPhone: true, tagsAny: ["VIP", "VIPER"] }],
    ["unknown keys", { lifecycle: ["customer"], ...({ foo: "bar", rfm: 3 } as object) }],
    ["all empty arrays", { industry: [], source: [], tagsAll: [], tagsAny: [], stageAny: [] }],
    ["search + source + stage", { search: "SARA", source: ["ig"], stageAny: ["new"] }],
    ["everything", { lifecycle: ["lead", "customer"], industry: ["tech"], source: ["wa", "ig"], search: "a", hasPhone: true, stageAny: ["new", "won"], tagsAll: ["Gold"], tagsAny: ["VIPER", "VIP"] }],
    ['raw "{}"', "{}"],
    ['raw "not json"', "not json"],
    ['raw "[]"', "[]"],
    ["raw stored JSON", JSON.stringify({ tagsAll: ["VIP"], tagsAny: ["Riyadh, KSA", "Gold"], hasPhone: false })],
  ];

  const legacyIds = (f: SegmentFilter | string) => {
    const filter = typeof f === "string" ? legacyParseFilter(f) : f;
    return evaluateContacts(t, legacyBuildWhere(WS, filter));
  };
  const rawOf = (f: SegmentFilter | string) => (typeof f === "string" ? f : JSON.stringify(f));

  it.each(FILTERS)("%s", async (_name, f) => {
    const read = readRules({ filter: rawOf(f), rules: null });
    expect(read.source).toBe("legacy");
    const compiled = await compileIn(t, read.tree);
    expect(compiled.issues).toEqual([]);
    expect(evaluateContacts(t, compiled.where)).toEqual(legacyIds(f));
  });

  it("the fixture discriminates (the table is not trivially empty or full)", () => {
    const sizes = new Set(FILTERS.map(([, f]) => legacyIds(f).length));
    expect(sizes.size).toBeGreaterThanOrEqual(12);
    expect(FILTERS.length).toBeGreaterThanOrEqual(20);
    // VIP vs VIPER really differ, and a malformed tags text is present.
    expect(legacyIds({ tagsAll: ["VIP"] })).not.toEqual(legacyIds({ tagsAll: ["VIPER"] }));
    expect(t.contact.some((c) => c.tags === "not json at all")).toBe(true);
  });

  it.each(FILTERS)("legacyProjection(legacyToTree(f)) round-trips: %s", (_name, f) => {
    const filter = typeof f === "string" ? legacyParseFilter(f) : f;
    const proj = legacyProjection(legacyToTree(filter));
    expect(proj).not.toBeNull();
    expect(evaluateContacts(t, legacyBuildWhere(WS, proj!))).toEqual(legacyIds(f));
  });

  it("{} matches every contact of the workspace and none of another", async () => {
    const compiled = await compileIn(t, readRules({ filter: "{}", rules: null }).tree);
    expect(compiled.where).toEqual({ workspaceId: WS });
    expect(evaluateContacts(t, compiled.where)).toEqual(wsIds);
  });

  it("SegmentsService.buildWhere (now a compiler wrapper) keeps the legacy shapes", () => {
    const svc = new SegmentsService({} as never);
    for (const [, f] of FILTERS) {
      const filter = typeof f === "string" ? legacyParseFilter(f) : f;
      expect(svc.buildWhere(WS, filter)).toEqual(legacyBuildWhere(WS, filter));
    }
  });
});

const tree = (...rules: AudienceNode[]): AudienceRules => ({ v: 2, op: "and", rules });

describe("each rule compiles to its documented predicate", () => {
  const w = predicateWorld();
  const ROWS: Array<[string, AudienceNode, string[]]> = [
    ["tag has VIP (not VIPER)", { field: "tag", op: "has", tag: "VIP" }, ["a1"]],
    ["tag not_has VIP", { field: "tag", op: "not_has", tag: "VIP" }, ["a2", "a3", "a4", "a5"]],
    ["lifecycle in lead", { field: "lifecycle", op: "in", values: ["lead"] }, ["a1", "a4"]],
    ["lifecycle not_in lead, customer (insensitive)", { field: "lifecycle", op: "not_in", values: ["lead", "customer"] }, ["a3"]],
    ["not_a_lead is", { field: "not_a_lead", op: "is" }, ["a2"]],
    ["not_a_lead is_not", { field: "not_a_lead", op: "is_not" }, ["a1", "a3", "a4", "a5"]],
    ["last_active within 7 days (inbound only)", { field: "last_active", op: "within", value: { amount: 7, unit: "days" } }, ["a1", "a5"]],
    ["last_active within 1 hours", { field: "last_active", op: "within", value: { amount: 1, unit: "hours" } }, ["a5"]],
    ["last_active more_than 7 days includes never-active", { field: "last_active", op: "more_than", value: { amount: 7, unit: "days" } }, ["a2", "a3", "a4"]],
    ["last_active within 6 weeks", { field: "last_active", op: "within", value: { amount: 6, unit: "weeks" } }, ["a1", "a2", "a5"]],
    ["conversations any", { field: "conversations", op: "any" }, ["a1", "a2", "a4", "a5"]],
    ["conversations none", { field: "conversations", op: "none" }, ["a3"]],
    ["channel is whatsapp", { field: "channel", op: "is", channel: "whatsapp" }, ["a1", "a4"]],
    ["channel is_not whatsapp includes no conversations", { field: "channel", op: "is_not", channel: "whatsapp" }, ["a2", "a3", "a5"]],
    ["created before 2026-02-28 (Riyadh midnight edge)", { field: "created", op: "before", date: "2026-02-28" }, ["a3", "a4"]],
    ["created after 2026-02-27 (Riyadh midnight edge)", { field: "created", op: "after", date: "2026-02-27" }, ["a1", "a2", "a5"]],
    ["created within 1 months (Mar 31 → Feb 28)", { field: "created", op: "within", value: { amount: 1, unit: "months" } }, ["a1", "a5"]],
    ["created more_than 1 months", { field: "created", op: "more_than", value: { amount: 1, unit: "months" } }, ["a2", "a3", "a4"]],
    ["created more_than 2 months (Jan 31 edge)", { field: "created", op: "more_than", value: { amount: 2, unit: "months" } }, ["a4"]],
    ["created within 2 hours", { field: "created", op: "within", value: { amount: 2, unit: "hours" } }, ["a5"]],
    ["group in manual", { field: "group", op: "in", segmentId: "G" }, ["a1", "a3"]],
    ["group not_in manual", { field: "group", op: "not_in", segmentId: "G" }, ["a2", "a4", "a5"]],
    ["group in hjz", { field: "group", op: "in", segmentId: "H" }, ["a5"]],
    ["group in smart", { field: "group", op: "in", segmentId: "S" }, ["a1", "a4"]],
    ["group not_in smart", { field: "group", op: "not_in", segmentId: "S" }, ["a2", "a3", "a5"]],
    ["custom text eq (case-sensitive)", { field: "custom_field", op: "eq", defId: "dT", value: "hello" }, ["a2"]],
    ["custom text contains", { field: "custom_field", op: "contains", defId: "dT", value: "World" }, ["a1"]],
    ["custom number gt", { field: "custom_field", op: "gt", defId: "dN", value: "7" }, ["a1"]],
    ["custom number lt", { field: "custom_field", op: "lt", defId: "dN", value: "7" }, ["a2"]],
    ["custom number eq (Arabic digits)", { field: "custom_field", op: "eq", defId: "dN", value: "١٠" }, ["a1"]],
    ["custom date gt", { field: "custom_field", op: "gt", defId: "dD", value: "2026-02-01" }, ["a2"]],
    ["custom date lt", { field: "custom_field", op: "lt", defId: "dD", value: "2026-02-01" }, ["a1"]],
    ["custom select eq", { field: "custom_field", op: "eq", defId: "dS", value: "Gold" }, ["a1"]],
    ["custom boolean true", { field: "custom_field", op: "eq", defId: "dB", value: "true" }, ["a1"]],
    ["custom boolean false includes no value", { field: "custom_field", op: "eq", defId: "dB", value: "false" }, ["a2", "a3", "a4", "a5"]],
    ["custom set", { field: "custom_field", op: "set", defId: "dT" }, ["a1", "a2"]],
    ["custom unset", { field: "custom_field", op: "unset", defId: "dT" }, ["a3", "a4", "a5"]],
    ["pipeline only: open cards", { field: "pipeline_stage", op: "in", pipelineId: "P1" }, ["a1"]],
    ["pipeline + terminal stage: closed card counts", { field: "pipeline_stage", op: "in", pipelineId: "P1", stageId: "s1won" }, ["a2"]],
    ["pipeline stage not_in", { field: "pipeline_stage", op: "not_in", pipelineId: "P1", stageId: "s1won" }, ["a1", "a3", "a4", "a5"]],
    ["campaign received", { field: "campaign", op: "received", campaignId: "C1" }, ["a1", "a2", "a3"]],
    ["campaign read", { field: "campaign", op: "read", campaignId: "C1" }, ["a2", "a3"]],
    ["campaign replied (a null-contact row never matches)", { field: "campaign", op: "replied", campaignId: "C1" }, ["a3"]],
    ["campaign not_replied", { field: "campaign", op: "not_replied", campaignId: "C1" }, ["a1", "a2"]],
    ["campaign failed", { field: "campaign", op: "failed", campaignId: "C1" }, ["a4"]],
    ["follow_up open", { field: "follow_up", op: "open" }, ["a1", "a2"]],
    ["follow_up overdue", { field: "follow_up", op: "overdue" }, ["a2"]],
    ["follow_up none_open", { field: "follow_up", op: "none_open" }, ["a3", "a4", "a5"]],
    ["or group", { op: "or", rules: [{ field: "not_a_lead", op: "is" }, { field: "conversations", op: "none" }] }, ["a2", "a3"]],
  ];

  it.each(ROWS)("%s", async (_name, rule, expected) => {
    const compiled = await compileIn(w, tree(rule));
    expect(compiled.issues).toEqual([]);
    expect(evaluateContacts(w, compiled.where)).toEqual(expected);
  });

  it("every relation filter carries the workspace (another workspace's activity never counts)", async () => {
    const c = await compileIn(w, tree({ field: "last_active", op: "within", value: { amount: 2, unit: "hours" } }));
    expect(JSON.stringify(c.where)).toContain(`"workspaceId":"${WS}"`);
    expect(evaluateContacts(w, c.where)).toEqual(["a5"]);
  });

  it("an AI or human reply alone does not make a contact active", async () => {
    const c = await compileIn(w, tree({ field: "last_active", op: "within", value: { amount: 2, unit: "days" } }));
    expect(evaluateContacts(w, c.where)).not.toContain("a2");
  });
});

describe("broken references match nobody for both operators", () => {
  const w = predicateWorld();
  const CASES: Array<[string, AudienceNode[], string]> = [
    ["missing group", [{ field: "group", op: "in", segmentId: "gone" }, { field: "group", op: "not_in", segmentId: "gone" }], "group_missing"],
    ["foreign group", [{ field: "group", op: "in", segmentId: "GB" }, { field: "group", op: "not_in", segmentId: "GB" }], "group_missing"],
    ["archived pipeline", [{ field: "pipeline_stage", op: "in", pipelineId: "P2" }, { field: "pipeline_stage", op: "not_in", pipelineId: "P2" }], "pipeline_archived"],
    ["missing pipeline", [{ field: "pipeline_stage", op: "in", pipelineId: "nope" }, { field: "pipeline_stage", op: "not_in", pipelineId: "nope" }], "pipeline_missing"],
    [
      "stage of another pipeline",
      [{ field: "pipeline_stage", op: "in", pipelineId: "P1", stageId: "s3new" }, { field: "pipeline_stage", op: "not_in", pipelineId: "P1", stageId: "s3new" }],
      "stage_missing",
    ],
    ["archived field", [{ field: "custom_field", op: "set", defId: "dX" }, { field: "custom_field", op: "unset", defId: "dX" }], "field_missing"],
    ["missing campaign", [{ field: "campaign", op: "received", campaignId: "gone" }, { field: "campaign", op: "not_replied", campaignId: "gone" }], "campaign_missing"],
    ["missing: true tag", [{ field: "tag", op: "has", tag: "VIP", missing: true }, { field: "tag", op: "not_has", tag: "VIP", missing: true }], "tag_deleted"],
    [
      "missing: true group",
      [{ field: "group", op: "in", segmentId: "G", missing: true }, { field: "group", op: "not_in", segmentId: "G", missing: true }],
      "group_missing",
    ],
  ];

  it.each(CASES)("%s → MATCH_NONE with one issue", async (_name, rules, kind) => {
    for (const r of rules) {
      const c = await compileIn(w, tree({ field: "lifecycle", op: "in", values: ["lead", "customer", "churned"] }, r));
      expect(c.where.AND).toContainEqual(MATCH_NONE);
      expect(evaluateContacts(w, c.where)).toEqual([]);
      expect(c.issues).toEqual([{ path: [1], kind }]);
    }
  });

  it("siblings in an or group still match", async () => {
    const c = await compileIn(w, tree({ op: "or", rules: [{ field: "group", op: "not_in", segmentId: "gone" }, { field: "lifecycle", op: "in", values: ["lead"] }] }));
    expect(c.issues).toEqual([{ path: [0, 0], kind: "group_missing" }]);
    expect(evaluateContacts(w, c.where)).toEqual(["a1", "a4"]);
  });
});

describe("broken references inside an expanded audience match nobody (fix C1)", () => {
  /** A world where smart audience B (and, two levels down, C) can be broken. */
  function world(bRules: AudienceRules, cRules?: AudienceRules) {
    const w = predicateWorld();
    w.segment.push(seg("B", WS, "crm", { rules: bRules }));
    if (cRules) w.segment.push(seg("C", WS, "crm", { rules: cRules }));
    return w;
  }
  const notInB = tree({ field: "group", op: "not_in", segmentId: "B" });
  const inB = tree({ field: "group", op: "in", segmentId: "B" });

  it("A = not_in B, where B's tag was deleted → nobody (not everyone), with the issue on A's rule", async () => {
    const w = world(tree({ field: "tag", op: "has", tag: "VIP", missing: true }));
    for (const t of [notInB, inB]) {
      const c = await compileIn(w, t);
      expect(evaluateContacts(w, c.where)).toEqual([]);
      expect(c.issues).toEqual([{ path: [0], kind: "tag_deleted" }]);
    }
  });

  const NESTED: Array<[string, AudienceNode, string]> = [
    ["an archived pipeline", { field: "pipeline_stage", op: "in", pipelineId: "P2" }, "pipeline_archived"],
    ["a stage of another pipeline", { field: "pipeline_stage", op: "not_in", pipelineId: "P1", stageId: "s3new" }, "stage_missing"],
    ["an archived field", { field: "custom_field", op: "unset", defId: "dX" }, "field_missing"],
    ["a deleted campaign", { field: "campaign", op: "not_replied", campaignId: "gone" }, "campaign_missing"],
    ["a deleted group", { field: "group", op: "not_in", segmentId: "gone" }, "group_missing"],
  ];

  it.each(NESTED)("%s nested 2 levels deep (A → B → C) → nobody for in and not_in", async (_n, broken, kind) => {
    // C's broken rule sits beside a healthy one, inside an `or`, so C alone would still match people.
    const w = world(tree({ field: "group", op: "in", segmentId: "C" }), tree({ op: "or", rules: [{ field: "lifecycle", op: "in", values: ["lead"] }, broken] }));
    for (const t of [notInB, inB]) {
      const c = await compileIn(w, t);
      expect(c.where.AND).toEqual([MATCH_NONE]);
      expect(evaluateContacts(w, c.where)).toEqual([]);
      expect(c.issues).toEqual([{ path: [0], kind }]);
    }
  });

  it("siblings of the broken reference in an `or` group still match", async () => {
    const w = world(tree({ field: "tag", op: "has", tag: "VIP", missing: true }));
    const c = await compileIn(w, tree({ op: "or", rules: [{ field: "group", op: "not_in", segmentId: "B" }, { field: "lifecycle", op: "in", values: ["lead"] }] }));
    expect(c.issues).toEqual([{ path: [0, 0], kind: "tag_deleted" }]);
    expect(evaluateContacts(w, c.where)).toEqual(["a1", "a4"]);
  });

  it("a healthy referenced audience still inlines (not_in excludes its members)", async () => {
    const w = world(tree({ field: "lifecycle", op: "in", values: ["lead"] }));
    const c = await compileIn(w, notInB);
    expect(c.issues).toEqual([]);
    expect(evaluateContacts(w, c.where)).toEqual(["a2", "a3", "a5"]);
  });
});

describe("one reference-chain depth limit at evaluation (fix I2)", () => {
  /** T → S1 → … → Sn, where Sn is `lifecycle in lead`. */
  function chain(n: number) {
    const w = predicateWorld();
    for (let i = 1; i <= n; i++) {
      const rules = i === n ? tree({ field: "lifecycle", op: "in", values: ["lead"] }) : tree({ field: "group", op: "in", segmentId: `S${i + 1}` });
      w.segment.push(seg(`S${i}`, WS, "crm", { rules }));
    }
    return w;
  }

  it(`a chain of ${AUDIENCE_LIMITS.maxReferenceDepth} smart audiences evaluates`, async () => {
    const w = chain(AUDIENCE_LIMITS.maxReferenceDepth);
    const c = await compileIn(w, tree({ field: "group", op: "in", segmentId: "S1" }));
    expect(c.issues).toEqual([]);
    expect(evaluateContacts(w, c.where)).toEqual(["a1", "a4"]);
  });

  it("a chain longer than the limit matches nobody for in and not_in, with issue too_deep (never a false cycle)", async () => {
    const w = chain(AUDIENCE_LIMITS.maxReferenceDepth + 1);
    for (const op of ["in", "not_in"] as const) {
      const c = await compileIn(w, tree({ field: "group", op, segmentId: "S1" }));
      expect(c.issues).toEqual([{ path: [0], kind: "too_deep" }]);
      expect(evaluateContacts(w, c.where)).toEqual([]);
    }
    // A much longer stored chain behaves the same and never recurses unboundedly.
    const long = chain(40);
    const c = await compileIn(long, tree({ field: "group", op: "not_in", segmentId: "S1" }));
    expect(c.issues).toEqual([{ path: [0], kind: "too_deep" }]);
  });

  it("a manual group named by the deepest allowed audience still resolves (the lookups load one hop further)", async () => {
    const w = chain(AUDIENCE_LIMITS.maxReferenceDepth);
    w.segment.find((s) => s.id === `S${AUDIENCE_LIMITS.maxReferenceDepth}`)!.rules = tree({ field: "group", op: "in", segmentId: "G" });
    const c = await compileIn(w, tree({ field: "group", op: "in", segmentId: "S1" }));
    expect(c.issues).toEqual([]);
    expect(evaluateContacts(w, c.where)).toEqual(["a1", "a3"]);
  });
});
