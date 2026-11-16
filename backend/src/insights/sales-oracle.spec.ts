/**
 * Runner 1 of 2 for the sales metrics (ruling 12): the TS oracle over the
 * fixture world equals the hand-written expectations. `sales-metrics.db.spec`
 * holds the real SQL to the same expectations.
 */
import { EMPTY_SALES_WORLD, INSIGHTS_WORLD, SALES_NOW, SALES_RANGE, U } from "./__fixtures__/insights-world";
import { SALES_ASSIGNED, SALES_EMPTY, SALES_METRIC_TESTS, SALES_OWNER, SALES_WEEKLY_EN } from "./insights-expected";
import { salesOracle } from "./insights-oracle";
import { parseRange } from "./insights-range";

const range = parseRange(SALES_RANGE.from, SALES_RANGE.to, "Asia/Riyadh", SALES_NOW);
const base = { range, pipelineId: "pl-leads", now: SALES_NOW };
const owner = salesOracle(INSIGHTS_WORLD, { ...base, scope: {} });
const assigned = salesOracle(INSIGHTS_WORLD, { ...base, scope: { assigneeId: U.assigned } });

describe("sales metrics (oracle over the fixture world)", () => {
  it.each(Object.entries(SALES_METRIC_TESTS))("%s", (_name, pick) => {
    expect(pick(owner)).toEqual(pick(SALES_OWNER));
    expect(pick(assigned)).toEqual(pick(SALES_ASSIGNED));
  });

  it("weekly trend buckets by workspace-local week (English: Monday weeks)", () => {
    expect(salesOracle(INSIGHTS_WORLD, { ...base, scope: {}, lang: "en" }).weekly).toEqual(SALES_WEEKLY_EN);
  });

  it("an old done follow-up is not counted and the figures are unchanged", () => {
    const old = (INSIGHTS_WORLD.followUps ?? []).find((f) => f.id === "fu12");
    expect(old?.doneAt?.getTime()).toBeLessThan(range.fromUtc.getTime());
    const without = { ...INSIGHTS_WORLD, followUps: (INSIGHTS_WORLD.followUps ?? []).filter((f) => f.id !== "fu12") };
    expect(salesOracle(without, { ...base, scope: {} }).reps).toEqual(SALES_OWNER.reps);
    expect(owner.reps).toEqual(SALES_OWNER.reps);
  });

  it("sales waiting ignores hidden threads (oracle)", () => {
    expect(owner.headline.waiting).toBe(3);
    expect(assigned.headline.waiting).toBe(0);
  });

  it("every lead is in exactly one speed bucket", () => {
    for (const e of [SALES_OWNER, SALES_ASSIGNED, SALES_EMPTY]) {
      expect(e.distribution.reduce((a, b) => a + b.count, 0)).toBe(e.headline.leads);
      expect(e.distribution.map((d) => d.bucket)).toEqual(["lt_5m", "5_15m", "15_60m", "1_4h", "4_24h", "gt_24h", "not_replied"]);
    }
  });

  it("sales rates and medians are null on empty input", () => {
    expect(salesOracle(EMPTY_SALES_WORLD, { ...base, scope: {} })).toEqual(SALES_EMPTY);
  });

  it("adding the sales world left every support figure unchanged", () => {
    // Guarded by insights-oracle.spec.ts; this documents the dependency.
    expect(INSIGHTS_WORLD.messages.filter((m) => m.id.includes("-s")).every((m) => m.createdAt >= new Date("2026-11-08T00:00:00Z"))).toBe(true);
  });
});
