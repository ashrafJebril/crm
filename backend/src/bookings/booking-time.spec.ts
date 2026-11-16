import {
  addDays,
  daysBetween,
  hhmm,
  instantOf,
  isDateISO,
  localDayRange,
  localSpan,
  parseHHMM,
  todayISO,
  wallClock,
  weekdayOf,
  workspaceTz,
} from "./booking-time";

const NY = "America/New_York";

describe("booking-time", () => {
  describe("dst day has correct slots", () => {
    it("spring forward (2026-03-08, America/New_York): 09:00 local is 13:00Z (EDT), the day before 14:00Z (EST)", () => {
      expect(instantOf("2026-03-07", 9 * 60, NY).toISOString()).toBe("2026-03-07T14:00:00.000Z");
      expect(instantOf("2026-03-08", 9 * 60, NY).toISOString()).toBe("2026-03-08T13:00:00.000Z");
      expect(instantOf("2026-03-08", 0, NY).toISOString()).toBe("2026-03-08T05:00:00.000Z");
      // The day is 23 hours long.
      const { start, end } = localDayRange("2026-03-08", NY);
      expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
    });

    it("fall back (2026-11-01, America/New_York): 09:00 local is 14:00Z (EST), the day before 13:00Z (EDT)", () => {
      expect(instantOf("2026-10-31", 9 * 60, NY).toISOString()).toBe("2026-10-31T13:00:00.000Z");
      expect(instantOf("2026-11-01", 9 * 60, NY).toISOString()).toBe("2026-11-01T14:00:00.000Z");
      const { start, end } = localDayRange("2026-11-01", NY);
      expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
    });

    it("wallClock inverts instantOf on both DST days", () => {
      for (const date of ["2026-03-08", "2026-11-01"]) {
        for (const min of [0, 9 * 60, 12 * 60 + 15, 23 * 60 + 45]) {
          expect(wallClock(instantOf(date, min, NY), NY)).toEqual({ dateISO: date, minutes: min, weekday: "sun" });
        }
      }
    });

    it("a 60-minute booking over the spring-forward gap ends at local 03:30", () => {
      const start = instantOf("2026-03-08", 90, NY); // 01:30 EST
      expect(localSpan(start, 60, NY)).toEqual({ dateISO: "2026-03-08", startMin: 90, endMin: 210 });
    });

    it("a booking over the fall-back hour is never shorter than its duration", () => {
      const start = new Date("2026-11-01T05:30:00Z"); // 01:30 EDT
      expect(localSpan(start, 60, NY)).toEqual({ dateISO: "2026-11-01", startMin: 90, endMin: 150 });
    });
  });

  it("wallClock reads the workspace zone, not UTC", () => {
    expect(wallClock(new Date("2026-11-17T22:30:00Z"), "Asia/Riyadh")).toEqual({
      dateISO: "2026-11-18",
      minutes: 90,
      weekday: "wed",
    });
    expect(wallClock(new Date("2026-11-17T22:30:00Z"), "Europe/London")).toEqual({
      dateISO: "2026-11-17",
      minutes: 22 * 60 + 30,
      weekday: "tue",
    });
  });

  it("instantOf(…, 1440) is the next local midnight", () => {
    expect(instantOf("2026-11-17", 1440, "Asia/Riyadh").toISOString()).toBe("2026-11-17T21:00:00.000Z");
  });

  it("localSpan marks a booking that crosses local midnight", () => {
    expect(localSpan(new Date("2026-11-17T20:30:00Z"), 60, "Asia/Riyadh")).toEqual({
      dateISO: "2026-11-17",
      startMin: 23 * 60 + 30,
      endMin: 1440 + 30,
    });
    expect(localSpan(new Date("2026-11-17T20:00:00Z"), 60, "Asia/Riyadh").endMin).toBe(1440);
  });

  it("workspaceTz validates through SP-04 validTz", () => {
    expect(workspaceTz("Europe/London")).toBe("Europe/London");
    expect(workspaceTz("Not/AZone")).toBe("Asia/Riyadh");
    expect(workspaceTz(null)).toBe("Asia/Riyadh");
    expect(workspaceTz("")).toBe("Asia/Riyadh");
  });

  it("date helpers", () => {
    expect(isDateISO("2026-02-28")).toBe(true);
    expect(isDateISO("2026-02-29")).toBe(false);
    expect(isDateISO("2026-2-1")).toBe(false);
    expect(isDateISO(20261117)).toBe(false);
    expect(weekdayOf("2026-11-17")).toBe("tue");
    expect(weekdayOf("2026-11-20")).toBe("fri");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-11-17", "2027-11-17")).toBe(365);
    expect(todayISO(new Date("2026-11-17T21:30:00Z"), "Asia/Riyadh")).toBe("2026-11-18");
  });

  it("HH:MM helpers", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("24:00")).toBe(1440);
    expect(parseHHMM("23:59")).toBe(1439);
    for (const bad of ["24:01", "25:00", "9:00", "09:60", "0900", "", null, 900]) expect(parseHHMM(bad)).toBeNull();
    expect(hhmm(0)).toBe("00:00");
    expect(hhmm(1440)).toBe("24:00");
    expect(hhmm(615)).toBe("10:15");
  });
});
