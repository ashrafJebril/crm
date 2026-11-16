import { describe, expect, it } from "vitest";
import {
  EMPTY_BOARD_FILTERS,
  decodeBoardFilters,
  encodeBoardFilters,
  filtersActive,
  presetRange,
  toQuery,
  nextSort,
  bulkResultText,
  SORT_KEYS,
} from "./boardQuery";

const tz = "Asia/Riyadh"; // UTC+3
// 2026-11-10 22:30 UTC is already 2026-11-11 01:30 in Riyadh.
const now = new Date("2026-11-10T22:30:00Z");

describe("presetRange", () => {
  it("today uses the workspace-local day, not the UTC day", () => {
    expect(presetRange("today", now, tz)).toEqual({ from: "2026-11-11", to: "2026-11-11" });
    expect(presetRange("today", now, "UTC")).toEqual({ from: "2026-11-10", to: "2026-11-10" });
  });
  it("7d and 30d are inclusive of today", () => {
    expect(presetRange("7d", now, tz)).toEqual({ from: "2026-11-05", to: "2026-11-11" });
    expect(presetRange("30d", now, tz)).toEqual({ from: "2026-10-13", to: "2026-11-11" });
  });
  it("month spans the whole local month", () => {
    expect(presetRange("month", now, tz)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(presetRange("month", new Date("2028-02-10T12:00:00Z"), tz)).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
  it("custom has no computed range; bad tz falls back instead of throwing", () => {
    expect(presetRange("custom", now, tz)).toBeNull();
    expect(presetRange("today", now, "Not/AZone")).not.toBeNull();
  });
});

describe("toQuery", () => {
  const ctx = { now, tz };
  it("is empty for empty filters and no sort", () => {
    expect(toQuery(EMPTY_BOARD_FILTERS, null, ctx)).toBe("");
  });
  it("maps every filter to the backend param names", () => {
    const qs = new URLSearchParams(
      toQuery(
        { ...EMPTY_BOARD_FILTERS, q: " ali ", status: "lost", ownerId: "none", contactId: "c1", preset: "custom", from: "2026-11-01", to: "2026-11-09" },
        null,
        ctx,
      ),
    );
    expect(Object.fromEntries(qs)).toEqual({ q: "ali", status: "lost", ownerId: "none", contactId: "c1", from: "2026-11-01", to: "2026-11-09" });
  });
  it("resolves a preset into from/to and ignores stale custom dates", () => {
    const qs = new URLSearchParams(toQuery({ ...EMPTY_BOARD_FILTERS, preset: "today", from: "2020-01-01", to: "2020-01-02" }, null, ctx));
    expect(qs.get("from")).toBe("2026-11-11");
    expect(qs.get("to")).toBe("2026-11-11");
  });
  it("drops an inverted custom range's bad bounds and malformed dates", () => {
    const qs = new URLSearchParams(toQuery({ ...EMPTY_BOARD_FILTERS, preset: "custom", from: "garbage", to: "2026-11-09" }, null, ctx));
    expect(qs.has("from")).toBe(false);
    expect(qs.get("to")).toBe("2026-11-09");
  });
  it("adds the table view and sort", () => {
    const qs = new URLSearchParams(toQuery(EMPTY_BOARD_FILTERS, { key: "value", dir: "asc" }, ctx));
    expect(Object.fromEntries(qs)).toEqual({ view: "table", sort: "value", dir: "asc" });
  });
});

describe("nextSort", () => {
  it("toggles direction on the same key and starts desc on a new one", () => {
    expect(nextSort({ key: "createdAt", dir: "desc" }, "createdAt")).toEqual({ key: "createdAt", dir: "asc" });
    expect(nextSort({ key: "createdAt", dir: "asc" }, "value")).toEqual({ key: "value", dir: "desc" });
  });
});

describe("hash encoding", () => {
  it("round-trips including Arabic names", () => {
    const f = { ...EMPTY_BOARD_FILTERS, contactId: "c1", contactName: "علي", status: "won" as const, preset: "7d" as const };
    expect(decodeBoardFilters(encodeBoardFilters(f))).toEqual(f);
  });
  it("tolerates garbage and unknown values", () => {
    expect(decodeBoardFilters("%%%")).toEqual(EMPTY_BOARD_FILTERS);
    expect(decodeBoardFilters(encodeBoardFilters({ status: "weird", preset: "x", ownerId: 5 }))).toEqual(EMPTY_BOARD_FILTERS);
  });
  it("filtersActive", () => {
    expect(filtersActive(EMPTY_BOARD_FILTERS)).toBe(false);
    expect(filtersActive({ ...EMPTY_BOARD_FILTERS, status: "open" })).toBe(true);
  });
});

describe("bulkResultText", () => {
  const tx = (en: string) => en;
  it("reports updated and skipped", () => {
    expect(bulkResultText(tx, { affected: 3, skipped: ["a", "b"] })).toBe("3 updated · 2 skipped");
    expect(bulkResultText(tx, { affected: 3, skipped: [] })).toBe("3 updated");
  });
});

describe("SP-09 support filters", () => {
  const ctx = { now, tz };
  it("board query round-trips priority, category and sla filters through the hash", () => {
    const f = {
      ...EMPTY_BOARD_FILTERS,
      priority: ["urgent" as const, "high" as const],
      category: ["complaint" as const],
      sla: "overdue" as const,
    };
    expect(decodeBoardFilters(encodeBoardFilters(f))).toEqual(f);
    expect(filtersActive(f)).toBe(true);
    expect(filtersActive({ ...EMPTY_BOARD_FILTERS, sla: "none" })).toBe(true);
    expect(filtersActive({ ...EMPTY_BOARD_FILTERS, category: ["other"] })).toBe(true);

    // Sent to GET /tickets as CSV params in the backend's list order.
    const qs = new URLSearchParams(toQuery({ ...f, priority: ["high", "urgent"] }, null, ctx));
    expect(qs.get("priority")).toBe("urgent,high");
    expect(qs.get("category")).toBe("complaint");
    expect(qs.get("sla")).toBe("overdue");
    expect(toQuery(EMPTY_BOARD_FILTERS, null, ctx)).toBe("");

    // Old hashes (before SP-09) decode to no support filter.
    const old = encodeBoardFilters({ q: "ali", status: "open" });
    expect(decodeBoardFilters(old)).toEqual({ ...EMPTY_BOARD_FILTERS, q: "ali", status: "open" });
    expect(decodeBoardFilters(old).priority).toEqual([]);
    expect(decodeBoardFilters(old).category).toEqual([]);
    expect(decodeBoardFilters(old).sla).toBe("");

    // Unknown values are dropped; duplicates collapse; non-arrays are ignored.
    const junk = encodeBoardFilters({ priority: ["urgent", "medium", "urgent", 3], category: "complaint", sla: "late" });
    expect(decodeBoardFilters(junk)).toEqual({ ...EMPTY_BOARD_FILTERS, priority: ["urgent"] });
  });

  it("sorts by slaDueAt and priority in the table", () => {
    expect(SORT_KEYS).toContain("slaDueAt");
    expect(SORT_KEYS).toContain("priority");
    const qs = new URLSearchParams(toQuery(EMPTY_BOARD_FILTERS, { key: "slaDueAt", dir: "asc" }, ctx));
    expect(Object.fromEntries(qs)).toEqual({ view: "table", sort: "slaDueAt", dir: "asc" });
    expect(nextSort({ key: "updatedAt", dir: "desc" }, "priority")).toEqual({ key: "priority", dir: "desc" });
  });
});

describe("SLA filter and sort only on support pipelines (final review I1)", () => {
  it("scopeToPipeline drops the sla filter and the slaDueAt sort off support pipelines", async () => {
    const { scopeToPipeline, DEFAULT_SORT } = await import("./boardQuery");
    const f = { ...EMPTY_BOARD_FILTERS, sla: "overdue" as const, priority: ["urgent" as const] };
    const sort = { key: "slaDueAt" as const, dir: "asc" as const };
    for (const kind of ["deals", "leads", undefined]) {
      const out = scopeToPipeline(f, sort, kind);
      expect(out.filters).toEqual({ ...f, sla: "" });
      expect(out.sort).toEqual(DEFAULT_SORT);
      const qs = toQuery(out.filters, out.sort, { now: new Date("2026-11-16T09:00:00Z"), tz: "Asia/Riyadh" });
      expect(new URLSearchParams(qs).get("sla")).toBeNull();
      expect(new URLSearchParams(qs).get("priority")).toBe("urgent");
    }
    // Support is unchanged (same objects).
    const sup = scopeToPipeline(f, sort, "support");
    expect(sup.filters).toBe(f);
    expect(sup.sort).toBe(sort);
    // Other sorts are kept on sales.
    const byPriority = { key: "priority" as const, dir: "desc" as const };
    expect(scopeToPipeline(f, byPriority, "deals").sort).toBe(byPriority);
  });
});
