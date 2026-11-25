import { describe, expect, it } from "vitest";
import backendStatus from "../../../backend/src/bookings/booking-status.ts?raw";
import type { Appointment, AppointmentStatus } from "@/lib/types";
import { BOOKING_ALLOWED, STATUS_ORDER, STATUS_WORDS, allowedFrom, canDrop } from "./bookingStatus";
import { agendaDays, bookedText } from "./agenda";
import { appointmentsQuery, parseCalendarParams, rangeFor, viewDays, weekStartOf, withCalendarParams } from "./calendarParams";
import { groupSlots, partOfDay } from "./slots";

const ARABIC = /[؀-ۿ]/;

describe("board allows only legal drops", () => {
  it("every pair of the table; completed → pending refused", () => {
    const legal = new Set(["pending>confirmed", "pending>cancelled", "confirmed>completed", "confirmed>no-show", "confirmed>cancelled"]);
    for (const from of STATUS_ORDER) {
      for (const to of STATUS_ORDER) {
        expect({ from, to, ok: canDrop(from, to) }).toEqual({ from, to, ok: legal.has(`${from}>${to}`) });
      }
    }
    expect(canDrop("completed", "pending")).toBe(false);
    expect(allowedFrom("weird")).toEqual([]);
  });

  it("mirrors the backend table exactly", () => {
    const m = /BOOKING_ALLOWED[^=]*=\s*\{([\s\S]*?)\};/.exec(backendStatus);
    expect(m).not.toBeNull();
    const backend: Record<string, string[]> = {};
    for (const line of m![1].split("\n")) {
      const r = /^\s*"?([a-z-]+)"?:\s*\[([^\]]*)\]/.exec(line);
      if (r) backend[r[1]] = [...r[2].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
    }
    expect(backend).toEqual(BOOKING_ALLOWED);
  });
});

describe("booking status words cover every status in both languages", () => {
  it("five statuses, plan copy, distinct words", () => {
    const statuses: AppointmentStatus[] = ["pending", "confirmed", "completed", "no-show", "cancelled"];
    expect([...STATUS_ORDER].sort()).toEqual([...statuses].sort());
    expect(STATUS_WORDS).toEqual({
      pending: ["Pending", "قيد الانتظار"],
      confirmed: ["Confirmed", "مؤكد"],
      completed: ["Completed", "مكتمل"],
      "no-show": ["No-show", "لم يحضر"],
      cancelled: ["Cancelled", "ملغي"],
    });
    for (const s of statuses) {
      expect(STATUS_WORDS[s][0]).not.toMatch(ARABIC);
      expect(STATUS_WORDS[s][1]).toMatch(ARABIC);
    }
    expect(new Set(statuses.map((s) => STATUS_WORDS[s][1])).size).toBe(5);
  });
});

const appt = (over: Partial<Appointment>): Appointment => ({
  id: Math.random().toString(36).slice(2),
  contactId: "c1",
  service: "Cut",
  serviceAr: "قص",
  startAt: "2026-11-17T06:00:00.000Z",
  durationMin: 60,
  status: "confirmed",
  source: "human",
  ...over,
});

describe("agenda sums booked minutes per local day", () => {
  it("a booking at 23:30 local belongs to its local day; cancelled and no-show excluded; per-staff split", () => {
    const tz = "Asia/Riyadh";
    const items = [
      appt({ startAt: "2026-11-17T06:00:00.000Z", durationMin: 60, resourceId: "r1" }), // Tue 09:00
      appt({ startAt: "2026-11-17T20:30:00.000Z", durationMin: 45, resourceId: "r1", status: "pending" }), // Tue 23:30 local
      appt({ startAt: "2026-11-17T21:30:00.000Z", durationMin: 30, resourceId: "r2", conflict: true }), // Wed 00:30 local
      appt({ startAt: "2026-11-17T08:00:00.000Z", durationMin: 90, staffId: "u9", status: "completed" }), // Tue, legacy
      appt({ startAt: "2026-11-17T09:00:00.000Z", durationMin: 60, resourceId: "r1", status: "cancelled" }),
      appt({ startAt: "2026-11-17T10:00:00.000Z", durationMin: 60, resourceId: "r1", status: "no-show" }),
    ];
    const days = agendaDays(items, tz);
    expect(days.map((d) => [d.date, d.minutes, d.count, d.conflicts])).toEqual([
      ["2026-11-17", 195, 3, 0],
      ["2026-11-18", 30, 1, 1],
    ]);
    expect(days[0].byResource).toEqual([
      { key: "r1", resourceId: "r1", staffId: null, minutes: 105, count: 2 },
      { key: "staff:u9", resourceId: null, staffId: "u9", minutes: 90, count: 1 },
    ]);
    // In London the 23:30-Riyadh booking is 20:30 on the same date; the 00:30 one is 21:30 the day before.
    expect(agendaDays(items, "Europe/London").map((d) => [d.date, d.minutes])).toEqual([["2026-11-17", 225]]);
    // Fixed days include empty ones and drop others.
    expect(agendaDays(items, tz, ["2026-11-16", "2026-11-17"]).map((d) => [d.date, d.minutes])).toEqual([
      ["2026-11-16", 0],
      ["2026-11-17", 195],
    ]);
  });

  it("booked-time words in both languages, Latin digits", () => {
    expect(bookedText(195, "en")).toBe("3 h 15 min booked");
    expect(bookedText(195, "ar")).toBe("3 س 15 د محجوزة");
    expect(bookedText(120, "en")).toBe("2 h booked");
    expect(bookedText(0, "en")).toBe("0 min booked");
  });
});

describe("calendar view, date and filters round-trip through the hash", () => {
  const today = "2026-11-17";

  it("old hashes without params decode to today's week view", () => {
    expect(parseCalendarParams("#/calendar", today)).toEqual({ view: "week", date: today, service: null, staff: null });
    expect(parseCalendarParams("", today)).toEqual({ view: "week", date: today, service: null, staff: null });
    expect(parseCalendarParams("#/calendar?view=moon&date=2026-02-30&service=%3Cx%3E", today)).toEqual({
      view: "week",
      date: today,
      service: null,
      staff: null,
    });
  });

  it("round-trips view, date and filters; defaults stay out; Task 4 params are kept", () => {
    let h = "#/calendar?tab=services&q=cut";
    h = withCalendarParams(h, { view: "board", date: "2026-12-01", service: "svc_1", staff: "res_2" }, today);
    expect(parseCalendarParams(h, today)).toEqual({ view: "board", date: "2026-12-01", service: "svc_1", staff: "res_2" });
    expect(h).toContain("tab=services");
    h = withCalendarParams(h, { view: "week", date: today, service: null, staff: null }, today);
    expect(h).toBe("#/calendar?tab=services&q=cut");
  });

  it("week starts by language; the fetch range covers the week (±1 day) in the workspace zone", () => {
    expect(weekStartOf("2026-11-17", "en")).toBe("2026-11-16"); // Monday
    expect(weekStartOf("2026-11-17", "ar")).toBe("2026-11-14"); // Saturday
    expect(viewDays("week", "2026-11-17", "ar")[0]).toBe("2026-11-14");
    expect(viewDays("day", "2026-11-17", "en")).toEqual(["2026-11-17"]);
    expect(rangeFor("week", "2026-11-17", "Asia/Riyadh", "en")).toEqual({ from: "2026-11-14T21:00:00.000Z", to: "2026-11-23T21:00:00.000Z" });
    const list = rangeFor("list", "2026-11-17", "Asia/Riyadh", "en");
    expect((new Date(list.to).getTime() - new Date(list.from).getTime()) / 86_400_000).toBeLessThanOrEqual(92);
    expect(appointmentsQuery({ view: "day", date: "2026-11-17", service: "s1", staff: null }, "Asia/Riyadh", "en")).toBe(
      "/appointments?from=2026-11-14T21%3A00%3A00.000Z&to=2026-11-23T21%3A00%3A00.000Z&limit=500&serviceId=s1",
    );
  });
});

describe("slot groups split morning, afternoon and evening in the workspace zone", () => {
  it("groups by local time and dedupes a start with several free staff", () => {
    const slots = [
      { startAt: "2026-11-17T09:00:00+03:00", resourceId: "r1" },
      { startAt: "2026-11-17T09:00:00+03:00", resourceId: "r2" },
      { startAt: "2026-11-17T11:45:00+03:00", resourceId: "r1" },
      { startAt: "2026-11-17T12:00:00+03:00", resourceId: "r1" },
      { startAt: "2026-11-17T16:45:00+03:00", resourceId: "r2" },
      { startAt: "2026-11-17T17:00:00+03:00", resourceId: "r1" },
    ];
    const g = groupSlots(slots, "Asia/Riyadh");
    expect(g.morning.map((s) => [s.time, s.resourceIds])).toEqual([
      ["09:00", ["r1", "r2"]],
      ["11:45", ["r1"]],
    ]);
    expect(g.afternoon.map((s) => s.time)).toEqual(["12:00", "16:45"]);
    expect(g.evening.map((s) => s.time)).toEqual(["17:00"]);
    // The same instants read in London are all morning/afternoon by London time.
    const london = groupSlots(slots, "Europe/London");
    expect(london.morning.map((s) => s.time)).toEqual(["06:00", "08:45", "09:00"]);
    expect(london.afternoon.map((s) => s.time)).toEqual(["13:45", "14:00"]);
    expect(london.evening).toEqual([]);
    expect([partOfDay(0), partOfDay(719), partOfDay(720), partOfDay(1019), partOfDay(1020)]).toEqual([
      "morning",
      "morning",
      "afternoon",
      "afternoon",
      "evening",
    ]);
  });
});
