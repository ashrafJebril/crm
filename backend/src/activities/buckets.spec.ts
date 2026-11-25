import { bucketOf, localDayBounds } from "./buckets";

// Asia/Dubai is UTC+4 with no DST. 2026-11-10 12:00 local = 08:00Z.
const NOW = new Date("2026-11-10T08:00:00Z");
const TZ = "Asia/Dubai";

describe("bucketOf (workspace timezone)", () => {
  it("23:30 local today is today, not upcoming", () => {
    expect(bucketOf(new Date("2026-11-10T19:30:00Z"), NOW, TZ)).toBe("today");
  });
  it("00:30 local tomorrow is upcoming", () => {
    expect(bucketOf(new Date("2026-11-10T20:30:00Z"), NOW, TZ)).toBe("upcoming");
  });
  it("1 minute ago is overdue", () => {
    expect(bucketOf(new Date(NOW.getTime() - 60_000), NOW, TZ)).toBe("overdue");
  });
  it("exactly now is today (overdue is strictly before now)", () => {
    expect(bucketOf(NOW, NOW, TZ)).toBe("today");
  });
  it("earlier today (already passed) is overdue", () => {
    expect(bucketOf(new Date("2026-11-10T00:30:00Z"), NOW, TZ)).toBe("overdue");
  });
  it("the same instant differs by timezone", () => {
    const due = new Date("2026-11-10T21:00:00Z");
    // 01:00 on the 11th in Dubai, 22:00 on the 10th in London... London is UTC in Nov.
    expect(bucketOf(due, NOW, "Asia/Dubai")).toBe("upcoming");
    expect(bucketOf(due, NOW, "Europe/London")).toBe("today");
  });
});

describe("localDayBounds", () => {
  it("returns the local midnight bounds as UTC instants [start, end)", () => {
    const { start, end } = localDayBounds(NOW, TZ);
    expect(start.toISOString()).toBe("2026-11-09T20:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-10T20:00:00.000Z");
  });
  it("handles a 23h DST day (America/New_York, 2026-03-08)", () => {
    const { start, end } = localDayBounds(new Date("2026-03-08T17:00:00Z"), "America/New_York");
    expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });
  it("a local day that started the previous UTC day", () => {
    // 01:00 Dubai on the 11th = 21:00Z on the 10th
    const { start } = localDayBounds(new Date("2026-11-10T21:00:00Z"), TZ);
    expect(start.toISOString()).toBe("2026-11-10T20:00:00.000Z");
  });
  it("falls back to the default (Asia/Riyadh) for an invalid timezone", () => {
    const { start } = localDayBounds(NOW, "Not/AZone");
    expect(start.toISOString()).toBe("2026-11-09T21:00:00.000Z");
  });
});

describe("Africa/Cairo DST", () => {
  // 2026 Egypt DST: starts Fri 24 Apr (00:00 -> 01:00, 23h day), ends Thu 29 Oct (24:00 -> 23:00, 25h day).
  it("spring forward: the 23h day starts at +2 and ends at +3", () => {
    const { start, end } = localDayBounds(new Date("2026-04-24T10:00:00Z"), "Africa/Cairo");
    expect(start.toISOString()).toBe("2026-04-23T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-04-24T21:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(23 * 3600_000);
  });
  it("fall back: the 25h day starts at +3 and ends at +2", () => {
    const { start, end } = localDayBounds(new Date("2026-10-29T10:00:00Z"), "Africa/Cairo");
    expect(start.toISOString()).toBe("2026-10-28T21:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-29T22:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(25 * 3600_000);
  });
  it("buckets straddle the transition correctly", () => {
    const now = new Date("2026-04-24T10:00:00Z");
    expect(bucketOf(new Date("2026-04-24T20:59:00Z"), now, "Africa/Cairo")).toBe("today");
    expect(bucketOf(new Date("2026-04-24T21:00:00Z"), now, "Africa/Cairo")).toBe("upcoming");
  });
});

describe("localDayBounds invalid tz", () => {
  it("falls back to Asia/Riyadh (not UTC) for an invalid zone", () => {
    expect(localDayBounds(NOW, "Bad/Zone")).toEqual(localDayBounds(NOW, "Asia/Riyadh"));
    expect(localDayBounds(NOW, "Bad/Zone").start.getTime()).not.toBe(localDayBounds(NOW, "UTC").start.getTime());
  });
});
