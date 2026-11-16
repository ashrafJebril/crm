/**
 * Runner 1 of 2 (ruling 12): the TS oracle over the fixture world equals the
 * hand-written expectations. Pins the metric *definitions* on every run;
 * `support-metrics.db.spec.ts` pins the SQL against the same expectations.
 */
import { CH, EMPTY_WORLD, INSIGHTS_WORLD, RANGE, U } from "./__fixtures__/insights-world";
import { ASSIGNED, EMPTY, OWNER, OWNER_JEDDAH_HEADLINE, SUPPORT_METRIC_TESTS } from "./insights-expected";
import { supportOracle } from "./insights-oracle";
import { parseRange } from "./insights-range";

const NOW = new Date("2026-11-10T09:00:00Z");
const range = parseRange(RANGE.from, RANGE.to, INSIGHTS_WORLD.workspace.timezone, NOW);
const owner = supportOracle(INSIGHTS_WORLD, { range, scope: {}, channelId: null });
const assigned = supportOracle(INSIGHTS_WORLD, { range, scope: { assigneeId: U.assigned }, channelId: null });

describe("support metrics (oracle over the fixture world)", () => {
  it.each(Object.entries(SUPPORT_METRIC_TESTS))("%s", (_name, pick) => {
    expect(pick(owner)).toEqual(pick(OWNER));
    expect(pick(assigned)).toEqual(pick(ASSIGNED));
  });

  it("the expectations are internally consistent", () => {
    for (const e of [OWNER, ASSIGNED, EMPTY]) {
      const mix = e.resolutionMix;
      expect(mix.ai + mix.human + mix.escalated + mix.closed).toBe(e.headline.decided);
      expect(mix.ai).toBe(e.headline.aiResolved);
      expect(e.peaks.byHour.reduce((a, b) => a + b, 0)).toBe(e.peaks.matrix.flat().reduce((a, b) => a + b, 0));
    }
    // The roadmap's world: AI-only excluded, 12 and 3 min kept, median 7.5 min.
    expect(OWNER.headline.medianFirstResponseSec).toBe(7.5 * 60);
  });

  it("rates and medians are null on empty input", () => {
    const empty = supportOracle(EMPTY_WORLD, { range, scope: {}, channelId: null });
    expect(empty).toEqual(EMPTY);
    // A closed scope (non-member) sees an empty world too.
    const closed = supportOracle(INSIGHTS_WORLD, { range, scope: { id: { in: [] } }, channelId: null });
    expect(closed.headline).toEqual(EMPTY.headline);
  });

  it("support insights respect assigned visibility (oracle)", () => {
    // Every figure equals the world restricted to the agent's conversations.
    const restricted = {
      ...INSIGHTS_WORLD,
      conversations: INSIGHTS_WORLD.conversations.filter((c) => c.assigneeId === U.assigned),
    };
    const viaWorld = supportOracle(restricted, { range, scope: {}, channelId: null });
    expect(assigned).toEqual(viaWorld);
    expect(assigned).toEqual(ASSIGNED);
  });

  it("the channel filter narrows every metric", () => {
    const jeddah = supportOracle(INSIGHTS_WORLD, { range, scope: {}, channelId: CH.b });
    expect(jeddah.headline).toEqual(OWNER_JEDDAH_HEADLINE);
    expect(jeddah.byNumber.map((r) => r.channelId)).toEqual([CH.b]);
  });
});
