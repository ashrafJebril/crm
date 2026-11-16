import { describe, expect, it } from "vitest";
import { availabilityPath, reschedulePatch } from "./bookingApi";

describe("reschedule sends only what changed (review R-M1)", () => {
  const appt = { startAt: "2026-11-17T06:00:00.000Z", durationMin: 60, resourceId: "r1", version: 4 };

  it("resourceId is omitted when unchanged, sent when changed, null to drop it", () => {
    expect(reschedulePatch(appt, { startAt: "2026-11-17T09:00:00+03:00", resourceId: "r1" })).toEqual({ version: 4 });
    expect(reschedulePatch(appt, { startAt: "2026-11-17T10:00:00+03:00" })).toEqual({ version: 4, startAt: "2026-11-17T10:00:00+03:00" });
    expect(reschedulePatch(appt, { startAt: appt.startAt, resourceId: "r2" })).toEqual({ version: 4, resourceId: "r2" });
    expect(reschedulePatch(appt, { startAt: appt.startAt, resourceId: null })).toEqual({ version: 4, resourceId: null });
    expect(reschedulePatch({ ...appt, resourceId: null }, { startAt: appt.startAt, resourceId: null })).toEqual({ version: 4 });
    expect(reschedulePatch(appt, { startAt: appt.startAt, durationMin: 90 })).toEqual({ version: 4, durationMin: 90 });
    expect(reschedulePatch({ ...appt, version: undefined as unknown as number }, { startAt: appt.startAt })).toEqual({ version: 0 });
  });

  it("availability path", () => {
    expect(availabilityPath({ serviceId: "s1", date: "2026-11-17" })).toBe("/bookings/availability?serviceId=s1&date=2026-11-17");
    expect(availabilityPath({ serviceId: "s1", resourceId: "r 2", date: "2026-11-17" })).toBe(
      "/bookings/availability?serviceId=s1&date=2026-11-17&resourceId=r+2",
    );
  });
});
