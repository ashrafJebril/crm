import { describe, expect, it } from "vitest";
import { importProgress, type PlatformImportStatus } from "./importProgress";

const now = Date.parse("2026-11-25T13:00:00.000Z");
const min = (m: number) => new Date(now + m * 60_000).toISOString();

const status = (over: Partial<PlatformImportStatus> = {}): PlatformImportStatus => ({
  connected: true,
  connectedAt: min(-30),
  importing: true,
  expectedBy: min(60),
  postCount: 0,
  lastSync: min(-4),
  syncTriggered: false,
  ...over,
});

describe("importProgress", () => {
  it("measures elapsed share of the import window", () => {
    expect(importProgress(status(), now)).toEqual({
      percent: 33,
      minutesSinceConnect: 30,
      minutesLeft: 60,
      minutesSinceSync: 4,
      overdue: false,
    });
  });

  it("caps at 95% and flags overdue once the expected time has passed", () => {
    const p = importProgress(status({ connectedAt: min(-120), expectedBy: min(-30) }), now);
    expect(p?.percent).toBe(95);
    expect(p?.minutesLeft).toBe(0);
    expect(p?.overdue).toBe(true);
  });

  it("is null when not importing or missing times", () => {
    expect(importProgress(undefined, now)).toBeNull();
    expect(importProgress(status({ importing: false }), now)).toBeNull();
    expect(importProgress(status({ expectedBy: null }), now)).toBeNull();
    expect(importProgress(status({ connectedAt: "x" }), now)).toBeNull();
  });

  it("leaves sync age unknown when Zernio hasn't synced", () => {
    expect(importProgress(status({ lastSync: null }), now)?.minutesSinceSync).toBeNull();
  });
});
