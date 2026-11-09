import { describe, expect, it } from "vitest";
import type { Campaign } from "@/lib/types";
import { campaignPollMs } from "@/screens/campaigns/campaignDetailModel";
import { resolvePollMs } from "./useFetch";

describe("resolvePollMs", () => {
  it("accepts a number, and treats missing or non-positive as no polling", () => {
    expect(resolvePollMs(5000, undefined)).toBe(5000);
    expect(resolvePollMs(undefined, undefined)).toBe(false);
    expect(resolvePollMs(0, undefined)).toBe(false);
  });

  it("reads the interval from the latest data, so a launch polls on its first response", () => {
    const pollMs = (c: Pick<Campaign, "status" | "launchedAt" | "scheduledAt"> | null | undefined) =>
      campaignPollMs(c ?? null, Date.now());
    // Nothing fetched yet: no polling. The very next result decides, with no render in between.
    expect(resolvePollMs(pollMs, undefined)).toBe(false);
    const launching = { status: "launching" as const, launchedAt: null, scheduledAt: null };
    expect(resolvePollMs(pollMs, launching)).toBeGreaterThan(0);
    expect(resolvePollMs(pollMs, { ...launching, status: "failed" })).toBe(false);
  });
});
