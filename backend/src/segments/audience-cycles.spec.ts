import { compileAudience, MATCH_NONE } from "./audience-compiler";
import { assertNoCycle } from "./audience-cycles";
import { audienceErrorBody } from "./audience-errors";
import { loadLookups, type LookupsPrisma } from "./audience-lookups";
import type { AudienceNode, AudienceRules } from "./audience-rules";
import { createAudienceDb, evaluateContacts } from "./audience-test-db";
import { NOW, predicateWorld, seg, WS } from "./__fixtures__/audience-world";
import { SegmentsService } from "./segments.service";

const tree = (...rules: AudienceNode[]): AudienceRules => ({ v: 2, op: "and", rules });
const ref = (segmentId: string, op: "in" | "not_in" = "in"): AudienceNode => ({ field: "group", op, segmentId });
const lead: AudienceNode = { field: "lifecycle", op: "in", values: ["lead"] };

async function bodyOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return audienceErrorBody(e);
  }
  throw new Error("expected a rejection");
}

function world() {
  const t = predicateWorld();
  t.segment.push(
    seg("A", WS, "crm", { rules: tree(ref("B")) }),
    seg("B", WS, "crm", { rules: tree(lead), version: 2 }),
    seg("C", WS, "crm", { rules: tree(lead) }),
    seg("D", WS, "crm", { rules: tree(lead) }),
  );
  const fake = createAudienceDb(t);
  const svc = new SegmentsService(fake.prisma as never);
  return { t, fake, svc };
}

describe("cyclic group membership rule rejected", () => {
  it("A references B; saving B with `group in A` → 400 rule_cycle {path: [B, A, B]} and B is unchanged", async () => {
    const { t, svc } = world();
    const before = JSON.stringify(t.segment.find((s) => s.id === "B"));
    const body = await bodyOf(svc.save(WS, { rules: tree(lead, ref("A")) }, { id: "B" }));
    expect(body).toMatchObject({ statusCode: 400, message: "audiences.rule_cycle", path: ["B", "A", "B"] });
    expect(JSON.stringify(t.segment.find((s) => s.id === "B"))).toBe(before);
  });

  it("self-reference → rule_cycle {path: [B, B]}", async () => {
    const { svc } = world();
    expect(await bodyOf(svc.save(WS, { rules: tree(ref("B")) }, { id: "B" }))).toMatchObject({
      message: "audiences.rule_cycle",
      path: ["B", "B"],
    });
  });

  it("a 3-cycle A→B→C→A, with the reference inside a nested `or` group under not_in", async () => {
    const { t, svc } = world();
    t.segment.find((s) => s.id === "B")!.rules = tree(ref("C"));
    t.segment.find((s) => s.id === "C")!.rules = tree({ op: "or", rules: [lead, ref("A", "not_in")] });
    // Saving A again (it already points at B) closes A→B→C→A.
    expect(await bodyOf(svc.save(WS, { rules: tree({ op: "or", rules: [lead, ref("B", "not_in")] }) }, { id: "A" }))).toMatchObject({
      message: "audiences.rule_cycle",
      path: ["A", "B", "C", "A"],
    });
    // Saving C's nested reference to A when A→B→C exists.
    t.segment.find((s) => s.id === "C")!.rules = tree(lead);
    expect(await bodyOf(svc.save(WS, { rules: tree({ op: "or", rules: [lead, ref("A", "not_in")] }) }, { id: "C" }))).toMatchObject({
      message: "audiences.rule_cycle",
      path: ["C", "A", "B", "C"],
    });
  });

  it("preview with excludeId detects the same cycle before the first save, and writes nothing", async () => {
    const { fake, svc } = world();
    expect(await bodyOf(svc.preview(WS, { rules: tree(ref("A")), excludeId: "B" }))).toMatchObject({
      message: "audiences.rule_cycle",
      path: ["B", "A", "B"],
    });
    expect(fake.calls.filter((c) => c.op === "update" || c.op === "create")).toEqual([]);
    // Without excludeId the same tree is a valid new audience.
    const ok = await svc.preview(WS, { rules: tree(ref("A")) }, { now: NOW });
    expect(ok.count).toBe(2);
  });

  it("a diamond (A→B, A→C, B→D, C→D) is accepted", async () => {
    const { t, svc } = world();
    t.segment.find((s) => s.id === "B")!.rules = tree(ref("D"));
    t.segment.find((s) => s.id === "C")!.rules = tree(ref("D"));
    const row = await svc.save(WS, { rules: tree(ref("B"), ref("C")) }, { id: "A", now: NOW });
    expect(row.rules).toEqual(tree(ref("B"), ref("C")));
    expect(row.issues).toEqual([]);
  });

  it("a manual-group reference never triggers the walk", async () => {
    const loadSmart = jest.fn(async () => new Map<string, AudienceRules>());
    await assertNoCycle(WS, "B", tree(ref("G"), ref("H", "not_in")), loadSmart, new Map([
      ["G", { origin: "manual" }],
      ["H", { origin: "hjz" }],
    ]));
    expect(loadSmart).not.toHaveBeenCalled();
    const { svc } = world();
    await expect(svc.save(WS, { rules: tree(ref("G")) }, { id: "B" })).resolves.toMatchObject({ id: "B" });
  });

  it("a stored cycle (rows written directly) compiles to MATCH_NONE with issue `cycle`: no recursion, no throw", async () => {
    const { t, fake, svc } = world();
    t.segment.find((s) => s.id === "B")!.rules = tree(lead, ref("A"));
    const stored = t.segment.find((s) => s.id === "A")!.rules as AudienceRules;
    const lookups = await loadLookups(fake.prisma as unknown as LookupsPrisma, WS, [stored]);
    const c = compileAudience(WS, stored, { now: NOW, tz: lookups.timezone, lookups, visited: new Set(["A"]), depth: 0 });
    expect(c.issues).toEqual([{ path: [0], kind: "cycle" }]);
    expect(c.where.AND).toEqual([MATCH_NONE]);
    // The live resolver (contacts list, campaigns) gets nobody, not an error.
    const where = await svc.resolveContactWhere(WS, "A", { now: NOW });
    expect(evaluateContacts(t, where)).toEqual([]);
    const row = await svc.detail(WS, "B", { now: NOW });
    expect(row.issues).toEqual([{ path: [1], kind: "cycle" }]);
    expect(row.count).toBe(0);
  });
});

describe("concurrent saves cannot close a cycle", () => {
  it("save takes pg_advisory_xact_lock first; two crossing saves never both succeed", async () => {
    const t = predicateWorld();
    t.segment.push(seg("A", WS, "crm", { rules: tree(lead) }), seg("B", WS, "crm", { rules: tree(lead) }));
    const fake = createAudienceDb(t, { serializeTransactions: true });
    const svc = new SegmentsService(fake.prisma as never);

    const results = await Promise.allSettled([
      svc.save(WS, { rules: tree(ref("B")) }, { id: "A" }),
      svc.save(WS, { rules: tree(ref("A")) }, { id: "B" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(audienceErrorBody(failed[0].reason)).toMatchObject({ statusCode: 400, message: "audiences.rule_cycle" });

    // In every transaction, the first statement is the workspace advisory lock.
    const txIds = [...new Set(fake.calls.filter((c) => c.tx !== null && c.model !== "$tx").map((c) => c.tx))];
    expect(txIds).toHaveLength(2);
    for (const id of txIds) {
      const first = fake.calls.find((c) => c.tx === id && c.model !== "$tx")!;
      expect(first.op).toBe("$executeRaw");
      expect(first.args.sql).toMatch(/SELECT pg_advisory_xact_lock\(hashtext\(\?\)\)/);
      expect(first.args.values).toEqual([`sp16:audiences:${WS}`]);
    }
  });
});
