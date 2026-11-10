import { describe, expect, it } from "vitest";
import { encodeJson } from "@/lib/hashState";
import { EMPTY_FILTER } from "./inboxFilters";
import {
  decodeFilter, encodeFilter, readFilterFromHash, readViewFromHash, writeFilterToHash, writeViewToHash, readNumberFromHash, writeNumberToHash,
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

describe("inboxHash number tab and channelIds (SP-19)", () => {
  it("round-trips channelIds", () => {
    const f = { ...EMPTY_FILTER, channelIds: ["c1", "c2"] };
    expect(decodeFilter(encodeFilter(f))).toEqual(f);
  });
  it("legacy hash decodes unchanged", () => {
    const legacy = btoa(encodeURIComponent(JSON.stringify({ bucket: "mine", tags: ["a"] })));
    expect(decodeFilter(legacy)).toEqual({ ...EMPTY_FILTER, bucket: "mine", tags: ["a"] });
    expect(readNumberFromHash("#/inbox?v=table")).toBeNull();
  });
  it("drops non-string channelIds", () => {
    const bad = btoa(encodeURIComponent(JSON.stringify({ channelIds: [1, "x"] })));
    expect(decodeFilter(bad).channelIds).toEqual(["x"]);
  });
  it("writes n= and keeps other params", () => {
    const h = writeNumberToHash("#/inbox?v=table", "w1");
    expect(readNumberFromHash(h)).toBe("w1");
    expect(new URLSearchParams(h.split("?")[1]).get("v")).toBe("table");
    expect(readNumberFromHash(writeNumberToHash(h, null))).toBeNull();
  });
});

describe("inbox ad-source filter round-trips through the hash", () => {
  it("round-trips any/none and specific ads", () => {
    for (const ad of [{ adFilter: "any" as const, adSourceIds: [] }, { adFilter: "none" as const, adSourceIds: [] }, { adFilter: null, adSourceIds: ["as1", "as2"] }]) {
      const f = { ...EMPTY_FILTER, ...ad };
      const h = writeFilterToHash("#/inbox?v=table", f);
      expect(readFilterFromHash(h)).toEqual(f);
      expect(readViewFromHash(h)).toBe("table");
    }
  });

  it("old hashes without the keys decode to adFilter null and no ads", () => {
    const old = encodeJson({ bucket: "mine", assigneeIds: [], labelIds: ["l1"], tags: [], lifecycles: [], channelIds: [], escalatedOnly: false });
    const f = decodeFilter(old);
    expect(f.adFilter).toBeNull();
    expect(f.adSourceIds).toEqual([]);
    expect(f.labelIds).toEqual(["l1"]);
  });

  it("ignores malformed values", () => {
    const f = decodeFilter(encodeJson({ adFilter: "maybe", adSourceIds: ["a", 3, null, { x: 1 }] }));
    expect(f.adFilter).toBeNull();
    expect(f.adSourceIds).toEqual(["a"]);
    expect(decodeFilter(encodeJson({ adSourceIds: "as1" })).adSourceIds).toEqual([]);
  });

  it("the empty filter leaves no f= param", () => {
    expect(writeFilterToHash("#/inbox", EMPTY_FILTER)).toBe("#/inbox");
  });
});
