import { describe, expect, it } from "vitest";
// The fixture the backend spec also runs (backend/src/agent/agent-hours.spec.ts).
import fixtureText from "../../../backend/src/agent/agent-hours.fixture.json?raw";
import { agentAvailableAt, insideSchedule } from "./agentHours";

const fixture = JSON.parse(fixtureText) as {
  schedules: Record<string, unknown>;
  cases: { mode: string; schedule: string; now: string; tz: string; available: boolean }[];
};

describe("agentHours mirrors the backend", () => {
  it("has the shared cases", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(23);
    expect(fixture.cases.some((c) => c.schedule === "mixed")).toBe(true);
    expect(fixture.cases.filter((c) => c.schedule === "nySpringGap" && c.tz === "America/New_York").length).toBeGreaterThanOrEqual(2);
  });

  it.each(fixture.cases.map((c) => [`${c.mode} ${c.schedule} ${c.now} ${c.tz}`, c] as const))("%s", (_n, c) => {
    expect(agentAvailableAt({ hoursMode: c.mode, schedule: fixture.schedules[c.schedule] }, new Date(c.now), c.tz)).toBe(c.available);
  });

  it("an empty or invalid schedule is null (fail open)", () => {
    expect(insideSchedule({}, new Date(), "Asia/Riyadh")).toBeNull();
    expect(insideSchedule("junk", new Date(), "Asia/Riyadh")).toBeNull();
  });
});
