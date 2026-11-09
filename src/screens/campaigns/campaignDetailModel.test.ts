import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import type { CampaignInsights, RecipientStatus } from "@/lib/types";
import {
  OUTCOME_ORDER,
  RECIPIENT_STATUSES,
  barPct,
  defaultGroupName,
  exportBody,
  exportFilename,
  followUpSummary,
  followUpTarget,
  formatPct,
  funnelSteps,
  insightsPollMs,
  mergePages,
  outcomeChips,
  readTimingShares,
  recipientsPath,
  replyLines,
  selectionState,
  statusLabel,
  toggleAllLoaded,
} from "./campaignDetailModel";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;
const H = 3_600_000;

const counts = (c: Partial<Record<RecipientStatus, number>>): Record<RecipientStatus, number> => ({
  queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0, ...c,
});

describe("readTimingShares", () => {
  it("readTimingShares sums to 100 and is null when empty", () => {
    expect(readTimingShares({ withinHour: 0, oneToSix: 0, sixToDay: 0, afterDay: 0 })).toBeNull();
    const s = readTimingShares({ withinHour: 1, oneToSix: 1, sixToDay: 1, afterDay: 0 })!;
    expect(s.map((x) => x.pct).reduce((a, b) => a + b, 0)).toBe(100);
    // Largest remainder: 33.33 each, the first tie gets the spare point.
    expect(s.map((x) => x.pct)).toEqual([34, 33, 33, 0]);
    expect(s.map((x) => x.key)).toEqual(["withinHour", "oneToSix", "sixToDay", "afterDay"]);
    const t = readTimingShares({ withinHour: 2, oneToSix: 5, sixToDay: 0, afterDay: 1 })!;
    expect(t.map((x) => x.pct)).toEqual([25, 63, 0, 12]);
    expect(t.map((x) => x.count)).toEqual([2, 5, 0, 1]);
    for (let a = 0; a < 7; a++)
      for (let b = 0; b < 7; b++) {
        const r = readTimingShares({ withinHour: a, oneToSix: b, sixToDay: 3, afterDay: 1 })!;
        expect(r.reduce((x, y) => x + y.pct, 0)).toBe(100);
      }
  });
});

describe("funnelSteps", () => {
  it("funnel steps use one outcome per row", () => {
    const steps = funnelSteps({ funnel: { targeted: 200, sent: 180, delivered: 150, read: 90, replied: 9 } });
    expect(steps.map((s) => s.key)).toEqual(["targeted", "sent", "delivered", "read", "replied"]);
    expect(steps.map((s) => s.count)).toEqual([200, 180, 150, 90, 9]);
    expect(steps.map((s) => s.pct)).toEqual([100, 90, 75, 45, 4.5]);
  });

  it("has no percentages when nobody was targeted", () => {
    const steps = funnelSteps({ funnel: { targeted: 0, sent: 0, delivered: 0, read: 0, replied: 0 } });
    expect(steps.every((s) => s.pct === null)).toBe(true);
    expect(formatPct(null)).toBe("—");
    expect(formatPct(4.5)).toBe("4.5%");
    expect(formatPct(100)).toBe("100%");
  });

  it("scales bars to the largest value", () => {
    expect(barPct(5, 10)).toBe(50);
    expect(barPct(0, 0)).toBe(0);
    expect(barPct(3, 3)).toBe(100);
  });
});

describe("mergePages", () => {
  it("mergePages dedupes by id", () => {
    const a = [{ id: "1" }, { id: "2" }];
    const b = [{ id: "2" }, { id: "3" }];
    expect(mergePages(a, b).map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(mergePages([], b)).toEqual(b);
  });
});

describe("selection", () => {
  it("reports none, some and all of the loaded rows", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(selectionState(new Set(), rows)).toBe("none");
    expect(selectionState(new Set(["a"]), rows)).toBe("some");
    expect(selectionState(new Set(["a", "b"]), rows)).toBe("all");
    expect(selectionState(new Set(), [])).toBe("none");
  });

  it("ticks every loaded row, and unticks them when all were ticked", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect([...toggleAllLoaded(new Set(["a"]), rows)].sort()).toEqual(["a", "b"]);
    expect([...toggleAllLoaded(new Set(["a", "b", "z"]), rows)]).toEqual(["z"]);
  });
});

describe("insightsPollMs", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  it("insightsPollMs stops 72h after launch", () => {
    expect(insightsPollMs({ status: "running", launchedAt: null }, now)).toBe(30_000);
    expect(insightsPollMs({ status: "scheduled", launchedAt: null }, now)).toBe(30_000);
    expect(insightsPollMs({ status: "completed", launchedAt: new Date(now - 71 * H).toISOString() }, now)).toBe(30_000);
    expect(insightsPollMs({ status: "completed", launchedAt: new Date(now - 72 * H).toISOString() }, now)).toBeNull();
    expect(insightsPollMs({ status: "draft", launchedAt: null }, now)).toBeNull();
    expect(insightsPollMs({ status: "failed", launchedAt: "garbage" }, now)).toBeNull();
    expect(insightsPollMs(null, now)).toBeNull();
  });
});

describe("outcomes", () => {
  it("status chips follow OUTCOME_ORDER", () => {
    expect(RECIPIENT_STATUSES).toHaveLength(7);
    expect([...OUTCOME_ORDER].sort()).toEqual([...RECIPIENT_STATUSES].sort());
    expect(OUTCOME_ORDER).toEqual(["delivered", "read", "replied", "sent", "failed", "skipped", "queued"]);
    const chips = outcomeChips(counts({ delivered: 3, read: 2, failed: 1 }), 6, en);
    expect(chips.map((c) => c.id)).toEqual(["all", ...OUTCOME_ORDER]);
    expect(chips.map((c) => c.count)).toEqual([6, 3, 2, 0, 0, 1, 0, 0]);
    expect(chips.map((c) => c.label)).toEqual([
      "All", "Not read", "Read", "Replied", "Waiting", "Failed", "Skipped", "Not sent",
    ]);
    for (const s of RECIPIENT_STATUSES) expect(statusLabel(s, ar)).toMatch(ARABIC);
  });

  it("maps an outcome to the recipients query", () => {
    expect(recipientsPath("c1", "all", null)).toBe("/campaigns/c1/recipients?limit=50");
    expect(recipientsPath("c1", "read", null)).toBe("/campaigns/c1/recipients?limit=50&status=read");
    expect(recipientsPath("c 1", "failed", "abc+/=")).toBe(
      "/campaigns/c%201/recipients?limit=50&status=failed&cursor=abc%2B%2F%3D",
    );
  });

  it("builds follow-up targets from an outcome or ticked rows", () => {
    expect(followUpTarget("outcome", "read", [])).toEqual({ status: "read" });
    expect(followUpTarget("ticked", "read", ["a", "b"])).toEqual({ ids: ["a", "b"] });
    // A follow-up needs exactly one of status or ids: "all" and no ticks have no target.
    expect(followUpTarget("outcome", "all", [])).toBeNull();
    expect(followUpTarget("ticked", "read", [])).toBeNull();
  });
});

describe("export", () => {
  it("builds the POST body per scope", () => {
    expect(exportBody("all", "read", ["x"], "ar")).toEqual({ lang: "ar" });
    expect(exportBody("outcome", "read", ["x"], "en")).toEqual({ status: "read", lang: "en" });
    expect(exportBody("outcome", "all", [], "en")).toEqual({ lang: "en" });
    expect(exportBody("ticked", "read", ["x", "y"], "en")).toEqual({ ids: ["x", "y"], lang: "en" });
  });

  it("prefers the server filename, else mirrors the backend pattern", () => {
    const day = new Date("2026-11-12T23:30:00Z");
    expect(exportFilename("campaign-x-all-2026-11-12.csv", { id: "c1", name: "X" }, "all", "all", day)).toBe(
      "campaign-x-all-2026-11-12.csv",
    );
    expect(exportFilename(null, { id: "c1", name: "Eid Sale!" }, "outcome", "read", day)).toBe(
      "campaign-eid-sale-read-2026-11-12.csv",
    );
    expect(exportFilename(null, { id: "c1", name: "عرض العيد" }, "ticked", "read", day)).toBe(
      "campaign-c1-selected-2026-11-12.csv",
    );
    expect(exportFilename(null, { id: "c1", name: "A" }, "outcome", "all", day)).toBe("campaign-a-all-2026-11-12.csv");
  });
});

describe("copy helpers", () => {
  it("names a new group after the campaign and outcome", () => {
    expect(defaultGroupName("Eid", "read", en)).toBe("Eid · Read");
    expect(defaultGroupName("Eid", "all", en)).toBe("Eid");
    expect(defaultGroupName("x".repeat(130), "read", en).length).toBeLessThanOrEqual(120);
  });

  it("summarises a follow-up result as added · already · left out", () => {
    expect(followUpSummary({ added: 3, already: 1, leftOut: 2 }, en)).toBe("3 added · 1 already there · 2 left out");
    expect(followUpSummary({ added: 3, already: 0, leftOut: 0 }, ar)).toMatch(ARABIC);
  });

  it("puts buttons first and typed replies last", () => {
    const replies: CampaignInsights["replies"] = [
      { payload: null, label: null, count: 9 },
      { payload: "YES", label: "Yes please", count: 4 },
      { payload: "NO", label: null, count: 6 },
    ];
    const lines = replyLines(replies, en);
    expect(lines.map((l) => l.text)).toEqual(["NO", "Yes please", "Typed replies"]);
    expect(lines.map((l) => l.typed)).toEqual([false, false, true]);
  });
});
