import { resolveDays, lastNDays } from "./dashboard.module";

describe("dashboard helpers", () => {
  it("resolves the days param safely", () => {
    expect(resolveDays(undefined)).toBe(7);
    expect(resolveDays("7")).toBe(7);
    expect(resolveDays("30")).toBe(30);
    expect(resolveDays("999")).toBe(7);
    expect(resolveDays("abc")).toBe(7);
  });

  it("pads lastNDays to n entries ending today (UTC)", () => {
    const days = lastNDays(30);
    expect(days).toHaveLength(30);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    expect(days[29]).toBe(today.toISOString().slice(0, 10));
  });
});
