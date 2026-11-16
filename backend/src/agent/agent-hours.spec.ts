import { agentAvailableAt, insideSchedule } from "./agent-hours";

const SUN_THU_9_17 = {
  sun: [{ from: "09:00", to: "17:00" }],
  mon: [{ from: "09:00", to: "17:00" }],
  tue: [{ from: "09:00", to: "17:00" }],
  wed: [{ from: "09:00", to: "17:00" }],
  thu: [{ from: "09:00", to: "17:00" }],
};
const RIYADH = "Asia/Riyadh";
const NEW_YORK = "America/New_York";

// 2026-11-22 is a Sunday; 2026-11-27 a Friday. Riyadh is UTC+3 all year.
const SUN_1000_RIYADH = new Date("2026-11-22T07:00:00Z");
const SUN_1800_RIYADH = new Date("2026-11-22T15:00:00Z");
const FRI_NOON_RIYADH = new Date("2026-11-27T09:00:00Z");

const at = (mode: string, schedule: unknown, now: Date, tz: string) => agentAvailableAt({ hoursMode: mode, schedule }, now, tz);

describe("agent working hours", () => {
  it("outside-hours mode replies only outside schedule (workspace TZ)", () => {
    // Riyadh: Sunday 10:00 is inside sun–thu 09:00–17:00.
    expect(at("outside", SUN_THU_9_17, SUN_1000_RIYADH, RIYADH)).toBe(false);
    expect(at("outside", SUN_THU_9_17, SUN_1800_RIYADH, RIYADH)).toBe(true);
    expect(at("outside", SUN_THU_9_17, FRI_NOON_RIYADH, RIYADH)).toBe(true);

    // The same instants in New York (UTC-5 in November) are different local times:
    // 07:00 UTC = Sun 02:00 (outside → reply), 15:00 UTC = Sun 10:00 (inside →
    // silent), 09:00 UTC Friday = Fri 04:00 (no Friday window → reply).
    expect(at("outside", SUN_THU_9_17, SUN_1000_RIYADH, NEW_YORK)).toBe(true);
    expect(at("outside", SUN_THU_9_17, SUN_1800_RIYADH, NEW_YORK)).toBe(false);
    expect(at("outside", SUN_THU_9_17, FRI_NOON_RIYADH, NEW_YORK)).toBe(true);

    // `within` is the exact complement, in both zones, over a whole week of hours.
    for (const tz of [RIYADH, NEW_YORK]) {
      for (let h = 0; h < 24 * 7; h++) {
        const now = new Date(Date.UTC(2026, 10, 22, h, 30));
        expect({ tz, h, sum: at("within", SUN_THU_9_17, now, tz) !== at("outside", SUN_THU_9_17, now, tz) }).toEqual({ tz, h, sum: true });
      }
    }
    expect(at("within", SUN_THU_9_17, SUN_1000_RIYADH, RIYADH)).toBe(true);
    expect(at("within", SUN_THU_9_17, FRI_NOON_RIYADH, RIYADH)).toBe(false);

    // `always` replies regardless of the schedule.
    for (const now of [SUN_1000_RIYADH, SUN_1800_RIYADH, FRI_NOON_RIYADH]) expect(at("always", SUN_THU_9_17, now, RIYADH)).toBe(true);
  });

  it("uses local wall time on New York DST change days", () => {
    // 2026-03-08 (Sunday): 02:00 EST jumps to 03:00 EDT. 02:30 never occurs.
    const spring = { sun: [{ from: "02:00", to: "03:00" }, { from: "03:00", to: "04:00" }] };
    const justOneWindow = { sun: [{ from: "03:00", to: "04:00" }] };
    // 06:59 UTC = 01:59 EST (outside both); 07:00 UTC = 03:00 EDT (inside the 03:00 window).
    expect(insideSchedule(justOneWindow, new Date("2026-03-08T06:59:00Z"), NEW_YORK)).toBe(false);
    expect(insideSchedule(justOneWindow, new Date("2026-03-08T07:00:00Z"), NEW_YORK)).toBe(true);
    expect(insideSchedule(justOneWindow, new Date("2026-03-08T07:59:00Z"), NEW_YORK)).toBe(true);
    expect(insideSchedule(justOneWindow, new Date("2026-03-08T08:00:00Z"), NEW_YORK)).toBe(false); // 04:00 EDT
    // The skipped 02:00–03:00 window is never inside on that day.
    expect(insideSchedule({ sun: [spring.sun[0]] }, new Date("2026-03-08T06:30:00Z"), NEW_YORK)).toBe(false); // 01:30 EST
    expect(insideSchedule({ sun: [spring.sun[0]] }, new Date("2026-03-08T07:30:00Z"), NEW_YORK)).toBe(false); // 03:30 EDT

    // 2026-11-01 (Sunday): 02:00 EDT falls back to 01:00 EST; 01:30 happens twice.
    const fall = { sun: [{ from: "01:00", to: "02:00" }] };
    expect(insideSchedule(fall, new Date("2026-11-01T05:30:00Z"), NEW_YORK)).toBe(true); // 01:30 EDT
    expect(insideSchedule(fall, new Date("2026-11-01T06:30:00Z"), NEW_YORK)).toBe(true); // 01:30 EST
    expect(insideSchedule(fall, new Date("2026-11-01T07:00:00Z"), NEW_YORK)).toBe(false); // 02:00 EST
    expect(at("outside", fall, new Date("2026-11-01T06:30:00Z"), NEW_YORK)).toBe(false);
  });

  it("an empty or invalid stored schedule fails open", () => {
    for (const bad of [null, undefined, {}, { sun: [] }, "junk", { sun: [{ from: "18:00", to: "09:00" }] }, { someday: [] }, [1, 2]]) {
      for (const mode of ["within", "outside"]) {
        expect({ bad, mode, ok: at(mode, bad, SUN_1000_RIYADH, RIYADH) }).toEqual({ bad, mode, ok: true });
      }
    }
    // An unknown mode is treated as always.
    expect(at("sometimes", SUN_THU_9_17, SUN_1000_RIYADH, RIYADH)).toBe(true);
  });

  it("a split day and a window ending at 24:00 are read like SP-10 schedules", () => {
    const split = { sun: [{ from: "09:00", to: "12:00" }, { from: "13:00", to: "24:00" }] };
    expect(insideSchedule(split, new Date("2026-11-22T09:30:00Z"), RIYADH)).toBe(false); // 12:30 break
    expect(insideSchedule(split, new Date("2026-11-22T20:59:00Z"), RIYADH)).toBe(true); // 23:59
    expect(insideSchedule(split, new Date("2026-11-22T21:00:00Z"), RIYADH)).toBe(false); // Monday 00:00
    // An invalid timezone falls back to the SP-10 default zone (Asia/Riyadh).
    expect(insideSchedule(SUN_THU_9_17, SUN_1000_RIYADH, "Not/AZone")).toBe(true);
  });
});
