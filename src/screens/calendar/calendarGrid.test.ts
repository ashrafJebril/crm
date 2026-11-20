import { describe, expect, it } from "vitest";
import type { Appointment } from "@/lib/types";
import { addDays, instantOf } from "./bookingTime";
import { LIMIT_NOTICE, LIST_LIMIT, appointmentsQuery, hitListLimit, rangeFor, viewDays } from "./calendarParams";
import { apptTop, bucketByDay, dayLabel, dayNumber, groupByDay, rangeLabel, timeOf, weekStats, weekdayShort } from "./calendarGrid";

const appt = (startAt: string, over: Partial<Appointment> = {}): Appointment => ({
  id: startAt,
  contactId: "c1",
  service: "Cut",
  serviceAr: "قص",
  startAt,
  durationMin: 60,
  status: "confirmed",
  source: "human",
  ...over,
});

describe("the week grid draws exactly what it fetched (final review I1)", () => {
  // Every weekday of one week, both languages and two zones.
  const dates = Array.from({ length: 7 }, (_, i) => addDays("2026-11-14", i)); // Sat .. Fri
  it.each(["en", "ar"] as const)("%s: every drawn day lies within the fetched range, for every weekday", (lang) => {
    for (const tz of ["Asia/Riyadh", "America/New_York"]) {
      for (const date of dates) {
        for (const view of ["week", "day", "board", "agenda", "list"] as const) {
          const { from, to } = rangeFor(view, date, tz, lang);
          for (const d of viewDays(view, date, lang)) {
            const start = instantOf(d, 0, tz).getTime();
            const end = instantOf(addDays(d, 1), 0, tz).getTime();
            expect({ lang, tz, date, view, d, inside: start >= new Date(from).getTime() && end <= new Date(to).getTime() }).toEqual({
              lang, tz, date, view, d, inside: true,
            });
          }
          // The selected date is always one of the drawn days.
          expect(viewDays(view, date, lang)).toContain(date);
        }
      }
    }
  });

  it.each(["en", "ar"] as const)("%s: the day view fetches every day of the stats week", (lang) => {
    for (const date of dates) {
      const { from, to } = rangeFor("day", date, "Asia/Riyadh", lang);
      for (const d of viewDays("week", date, lang)) {
        const inside = instantOf(d, 0, "Asia/Riyadh").getTime() >= new Date(from).getTime() && instantOf(addDays(d, 1), 0, "Asia/Riyadh").getTime() <= new Date(to).getTime();
        expect({ lang, date, d, inside }).toEqual({ lang, date, d, inside: true });
      }
    }
  });

  it("Arabic weeks start on Saturday, English on Monday; Sunday is never dropped", () => {
    expect(viewDays("week", "2026-11-15", "ar")).toEqual(["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
    expect(viewDays("week", "2026-11-15", "en")).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  });

  it("stats count today and the week on the same days the grid draws", () => {
    const days = viewDays("week", "2026-11-15", "ar"); // Sat 14 .. Fri 20
    const items = [
      appt("2026-11-15T07:00:00.000Z"), // Sun 10:00 Riyadh: today
      appt("2026-11-14T07:00:00.000Z", { status: "completed" }),
      appt("2026-11-20T20:30:00.000Z", { status: "no-show" }), // Fri 23:30 Riyadh: still in the week
      appt("2026-11-20T21:30:00.000Z"), // Sat 21 00:30 Riyadh: next week
    ];
    expect(weekStats(items, days, "2026-11-15", "Asia/Riyadh")).toEqual({ todayCount: 1, weekCount: 3, noShowPct: 50 });
  });
});

describe("week and day grids use the workspace timezone (final review I2)", () => {
  it("an Asia/Riyadh 10:00 booking renders at 10:00 in its local day column, whatever the process zone", () => {
    const tz = "Asia/Riyadh";
    const a = appt("2026-11-17T07:00:00.000Z"); // 10:00 Riyadh, 07:00 UTC
    expect(timeOf(a.startAt, tz)).toBe("10:00");
    expect(apptTop(a.startAt, tz, 8, 56)).toBe(112); // 2 hours below the 08:00 line
    const days = viewDays("week", "2026-11-17", "en");
    const byDay = bucketByDay([a], days, tz);
    expect(byDay.get("2026-11-17")?.map((x) => x.id)).toEqual([a.id]);
  });

  it("a booking at 23:30 local goes to its local day even though UTC already says the same day earlier", () => {
    const tz = "Asia/Riyadh";
    const late = appt("2026-11-17T20:30:00.000Z"); // 23:30 Tue in Riyadh
    const afterMidnight = appt("2026-11-17T21:30:00.000Z"); // 00:30 Wed in Riyadh (Tue in UTC)
    const days = viewDays("week", "2026-11-17", "en");
    const byDay = bucketByDay([late, afterMidnight], days, tz);
    expect(byDay.get("2026-11-17")?.map((x) => x.id)).toEqual([late.id]);
    expect(byDay.get("2026-11-18")?.map((x) => x.id)).toEqual([afterMidnight.id]);
    expect(timeOf(afterMidnight.startAt, tz)).toBe("00:30");
    expect(groupByDay([afterMidnight, late], tz).map((g) => g.day)).toEqual(["2026-11-17", "2026-11-18"]);
    // The same instants in New York belong to Tuesday afternoon.
    expect(groupByDay([afterMidnight, late], "America/New_York").map((g) => [g.day, g.list.length])).toEqual([["2026-11-17", 2]]);
  });

  it("labels come from the calendar date (no browser zone shift) with Latin digits", () => {
    expect(dayNumber("2026-11-05")).toBe("5");
    expect(weekdayShort("2026-11-17", "en")).toBe("Tue");
    expect(dayLabel("2026-11-17", "en")).toBe("Tuesday, Nov 17");
    expect(dayLabel("2026-11-17", "ar")).toMatch(/17/);
    expect(dayLabel("2026-11-17", "ar")).not.toMatch(/[٠-٩]/);
    expect(rangeLabel("2026-11-14", "2026-11-20", "en")).toBe("Nov 14 – Nov 20");
  });
});

describe("a full page of bookings is announced, not silently cut (final review M6)", () => {
  it("the query asks for 500; 500 rows triggers the notice; the copy has Latin digits", () => {
    expect(LIST_LIMIT).toBe(500);
    expect(appointmentsQuery({ view: "week", date: "2026-11-17", service: null, staff: null }, "Asia/Riyadh", "en")).toContain("limit=500");
    expect(hitListLimit(499)).toBe(false);
    expect(hitListLimit(500)).toBe(true);
    expect(LIMIT_NOTICE).toEqual([
      "Showing the first 500 bookings — narrow the dates or filters",
      "يتم عرض أول 500 حجز — ضيّق التواريخ أو عوامل التصفية",
    ]);
    expect(LIMIT_NOTICE[1]).not.toMatch(/[٠-٩]/);
  });
});
