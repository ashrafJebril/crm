import { describe, expect, it } from "vitest";
import { winRatePercent } from "./winRate";

describe("dashboard win rate", () => {
  it("shows the server's percent as is (no double scaling)", () => {
    expect(winRatePercent({ winRate: 50 })).toBe(50);
    expect(winRatePercent({ winRate: 0 })).toBe(0);
    expect(winRatePercent({ winRate: 100 })).toBe(100);
    expect(winRatePercent({ winRate: 66.7 })).toBe(67);
    expect(winRatePercent(null)).toBe(0);
    expect(winRatePercent({ winRate: Number.NaN })).toBe(0);
  });
});
