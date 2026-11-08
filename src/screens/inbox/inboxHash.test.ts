import { describe, expect, it } from "vitest";
import { EMPTY_FILTER } from "./inboxFilters";
import {
  decodeFilter, encodeFilter, readFilterFromHash, readViewFromHash, writeFilterToHash, writeViewToHash,
} from "./inboxHash";

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
  it("reads and writes the view param, keeping the filter", () => {
    expect(readViewFromHash("#/inbox")).toBe("list");
    expect(readViewFromHash("#/inbox?v=board")).toBe("board");
    expect(readViewFromHash("#/inbox?v=table")).toBe("table");
    expect(readViewFromHash("#/inbox?v=nope")).toBe("list");
    const h = writeViewToHash(writeFilterToHash("#/inbox", f), "board");
    expect(readViewFromHash(h)).toBe("board");
    expect(readFilterFromHash(h)).toEqual(f);
    expect(writeViewToHash("#/inbox?v=board", "list")).toBe("#/inbox");
  });
});
