import { describe, expect, it } from "vitest";
import { availabilityPath, rescheduleBody, reschedulePatch } from "./bookingApi";

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

describe("reschedule body (final review M3) and availability for reschedule (M2, M5)", () => {
  const mcpRow = { startAt: "2026-11-17T06:00:00.000Z", durationMin: 45, resourceId: null, version: 2 };

  it("a picked slot always sends its resourceId (\"Any available\" on a row without a resource)", () => {
    expect(rescheduleBody(mcpRow, { startAt: "2026-11-17T10:00:00+03:00", slotResourceId: "r7" })).toEqual({
      version: 2,
      startAt: "2026-11-17T10:00:00+03:00",
      resourceId: "r7",
    });
  });

  it("a manual time with the staff field untouched omits resourceId; a touched field sends it (or null)", () => {
    expect(rescheduleBody(mcpRow, { startAt: "2026-11-18T06:00:00.000Z" })).toEqual({ version: 2, startAt: "2026-11-18T06:00:00.000Z" });
    const linked = { ...mcpRow, resourceId: "r1" };
    expect(rescheduleBody(linked, { startAt: linked.startAt, staff: { touched: true, value: null } })).toEqual({ version: 2, resourceId: null });
    expect(rescheduleBody(linked, { startAt: linked.startAt, staff: { touched: false, value: "r9" } })).toEqual({ version: 2 });
  });

  it("availability for a reschedule excludes the booking and uses its own duration", () => {
    expect(availabilityPath({ serviceId: "s1", date: "2026-11-17", excludeAppointmentId: "a1", durationMin: 45 })).toBe(
      "/bookings/availability?serviceId=s1&date=2026-11-17&excludeAppointmentId=a1&durationMin=45",
    );
  });
});
