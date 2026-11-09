import { describe, expect, it } from "vitest";
import { clean } from "./TopicsCard";

describe("TopicsCard clean", () => {
  it("drops blanks and non-strings and de-duplicates (chips are keyed by their text)", () => {
    expect(clean(["pricing", "pricing", "", "  ", 5, "delivery"])).toEqual(["pricing", "delivery"]);
    expect(clean(null)).toEqual([]);
  });
});
