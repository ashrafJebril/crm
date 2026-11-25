import { describe, expect, it } from "vitest";
import { pageWindow, rangeLabel } from "./paging";

describe("pageWindow", () => {
  it("lists every page when there are few", () => {
    expect(pageWindow(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the first, last and neighbours, with gaps", () => {
    expect(pageWindow(10, 40)).toEqual([1, "gap", 9, 10, 11, "gap", 40]);
  });

  it("does not leave a gap of one page", () => {
    expect(pageWindow(3, 40)).toEqual([1, 2, 3, 4, "gap", 40]);
    expect(pageWindow(38, 40)).toEqual([1, "gap", 37, 38, 39, 40]);
  });
});

describe("rangeLabel", () => {
  it("describes the rows on screen", () => {
    expect(rangeLabel(2, 50, 120)).toEqual({ from: 51, to: 100, total: 120 });
    expect(rangeLabel(3, 50, 120)).toEqual({ from: 101, to: 120, total: 120 });
    expect(rangeLabel(1, 50, 0)).toEqual({ from: 0, to: 0, total: 0 });
  });
});
