import { describe, expect, it } from "vitest";
import { EMPTY_FILTER } from "./inboxFilters";
import { decodeFilter, encodeFilter, readFilterFromHash, writeFilterToHash } from "./inboxHash";

describe("inboxHash", () => {
  const f = {
    ...EMPTY_FILTER,
    bucket: "mine" as const,
    tags: ["عميل مهم"],
    escalatedOnly: true,
    from: "2026-01-02",
  };
  it("round-trips including Arabic", () => {
    expect(decodeFilter(encodeFilter(f))).toEqual(f);
  });
  it("falls back to EMPTY_FILTER on garbage", () => {
    expect(decodeFilter("%%%")).toEqual(EMPTY_FILTER);
    expect(decodeFilter(btoa("not json"))).toEqual(EMPTY_FILTER);
    expect(decodeFilter(btoa("[1]"))).toEqual(EMPTY_FILTER);
    expect(decodeFilter(null)).toEqual(EMPTY_FILTER);
  });
  it("sanitises bad fields", () => {
    const bad = btoa(encodeURIComponent(JSON.stringify({ bucket: "x", labelIds: [1, "a"] })));
    expect(decodeFilter(bad)).toEqual({ ...EMPTY_FILTER, labelIds: ["a"] });
  });
  it("keeps other params and removes f when empty", () => {
    const h = writeFilterToHash("#/inbox?v=table", f);
    expect(new URLSearchParams(h.split("?")[1]).get("v")).toBe("table");
    expect(readFilterFromHash(h)).toEqual(f);
    expect(writeFilterToHash(h, EMPTY_FILTER)).toBe("#/inbox?v=table");
    expect(writeFilterToHash("#/inbox?f=abc", EMPTY_FILTER)).toBe("#/inbox");
  });
});
