import { describe, expect, it } from "vitest";
// Fixture and backend sources are read as text (never compiled here).
import fixtureRaw from "./__fixtures__/fit-cases.json?raw";
import backendSpec from "../../../backend/src/bookings/schedule.spec.ts?raw";
import backendSchedule from "../../../backend/src/bookings/schedule.ts?raw";
import backendConstants from "../../../backend/src/bookings/booking-constants.ts?raw";
import * as C from "./bookingConstants";
import {
  SCHEDULE_INVALID_REASONS,
  isConfigured,
  scheduleFitAt,
  scheduleSummary,
  validateSchedule,
  weekOrder,
  type WeeklySchedule,
} from "./schedule";
import { instantOf, wallClock } from "./bookingTime";

interface FitCase {
  name: string;
  schedule: string;
  tz: string;
  startAt: string;
  durationMin: number;
  expect: unknown;
}
const fixture = JSON.parse(fixtureRaw) as { schedules: Record<string, WeeklySchedule>; cases: FitCase[] };

describe("schedule-fit rejects outside hours in workspace TZ", () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(scheduleFitAt(fixture.schedules[c.schedule], new Date(c.startAt), c.durationMin, c.tz)).toEqual(c.expect);
  });

  it("the fixture is the backend spec's table (every instant appears there)", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(15);
    for (const c of fixture.cases) {
      const iso = c.startAt.replace("Z", "");
      expect({ name: c.name, inBackend: backendSpec.includes(iso) }).toEqual({ name: c.name, inBackend: true });
    }
  });

  it("DST: New York 02:30 on the spring-forward day resolves after the gap; wallClock inverts instantOf", () => {
    expect(instantOf("2026-03-08", 150, "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(instantOf("2026-11-01", 90, "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(wallClock(new Date("2026-11-17T22:30:00Z"), "Asia/Riyadh")).toEqual({ dateISO: "2026-11-18", minutes: 90, weekday: "wed" });
  });
});

describe("validateSchedule mirrors bookings.schedule_invalid", () => {
  it("the reasons equal the backend's", () => {
    const m = /export type ScheduleInvalidReason =([\s\S]*?);/.exec(backendSchedule);
    expect(m).not.toBeNull();
    const backend = [...m![1].matchAll(/"([a-z_0-9]+)"/g)].map((x) => x[1]);
    expect([...SCHEDULE_INVALID_REASONS].sort()).toEqual(backend.sort());
  });

  it.each([
    ["not an object", [], { day: null, index: null, reason: "not_object" }],
    ["unknown day", { monday: [] }, { day: "monday", index: null, reason: "unknown_day" }],
    ["non-array day", { mon: {} }, { day: "mon", index: null, reason: "not_array" }],
    [
      "4 windows",
      { tue: [{ from: "08:00", to: "09:00" }, { from: "10:00", to: "11:00" }, { from: "12:00", to: "13:00" }, { from: "14:00", to: "15:00" }] },
      { day: "tue", index: 3, reason: "too_many_windows" },
    ],
    ["window not an object", { wed: ["x"] }, { day: "wed", index: 0, reason: "window_invalid" }],
    ["25:00", { thu: [{ from: "09:00", to: "25:00" }] }, { day: "thu", index: 0, reason: "time_invalid" }],
    ["24:00 as a start", { fri: [{ from: "24:00", to: "24:00" }] }, { day: "fri", index: 0, reason: "start_at_24" }],
    ["from >= to", { sat: [{ from: "22:00", to: "02:00" }] }, { day: "sat", index: 0, reason: "from_not_before_to" }],
    ["overlap reports the input index", { mon: [{ from: "16:00", to: "21:00" }, { from: "09:00", to: "17:00" }] }, { day: "mon", index: 0, reason: "overlap" }],
  ])("%s", (_n, input, error) => {
    expect(validateSchedule(input)).toEqual({ ok: false, error });
  });

  it("a valid schedule is canonical (Monday order, sorted windows, empty days dropped)", () => {
    expect(
      validateSchedule({ wed: [{ from: "16:00", to: "21:00" }, { from: "09:00", to: "13:00" }], sun: [], mon: [{ from: "00:00", to: "24:00" }] }),
    ).toEqual({
      ok: true,
      schedule: { mon: [{ from: "00:00", to: "24:00" }], wed: [{ from: "09:00", to: "13:00" }, { from: "16:00", to: "21:00" }] },
    });
    expect(isConfigured({})).toBe(false);
  });
});

describe("schedule summary in both languages", () => {
  const SUN_THU = fixture.schedules.SUN_THU;

  it("groups days with the same hours, wrapping around the week; Latin digits in Arabic", () => {
    expect(scheduleSummary(SUN_THU, "en")).toBe("Sun–Thu 09:00–17:00");
    expect(scheduleSummary(SUN_THU, "ar")).toBe("الأحد–الخميس 09:00–17:00");
    const mixed: WeeklySchedule = { ...SUN_THU, sat: [{ from: "10:00", to: "14:00" }] };
    expect(scheduleSummary(mixed, "en")).toBe("Sun–Thu 09:00–17:00 · Sat 10:00–14:00");
    expect(scheduleSummary(mixed, "ar")).toBe("السبت 10:00–14:00 · الأحد–الخميس 09:00–17:00");
    expect(scheduleSummary({ mon: [{ from: "09:00", to: "13:00" }, { from: "16:00", to: "21:00" }], wed: [{ from: "09:00", to: "13:00" }, { from: "16:00", to: "21:00" }] }, "en")).toBe(
      "Mon, Wed 09:00–13:00, 16:00–21:00",
    );
  });

  it("an unconfigured schedule says so", () => {
    expect(scheduleSummary({}, "en")).toBe("Schedule not set");
    expect(scheduleSummary(null, "ar")).toBe("لم يُحدَّد الجدول");
  });

  it("the week starts on Saturday in Arabic and Monday in English", () => {
    expect(weekOrder("ar")[0]).toBe("sat");
    expect(weekOrder("en")[0]).toBe("mon");
  });
});

describe("booking constants mirror the backend", () => {
  it.each([
    "SLOT_STEP_MIN", "MAX_DAYS_AHEAD", "MAX_WINDOWS_PER_DAY", "MAX_LIST_RANGE_DAYS", "SERVICE_DURATION_MIN",
    "SERVICE_DURATION_MAX", "MAX_PROPOSED_SERVICES", "MAX_PROPOSED_STAFF", "MAX_CATALOG_SOURCE_CHARS", "MAX_CATALOG_FILE_ROWS",
    "MAX_NAME_LENGTH", "MAX_ROLE_LENGTH",
  ])("%s", (name) => {
    const m = new RegExp(`export const ${name} = ([0-9_]+);`).exec(backendConstants);
    expect(m, name).not.toBeNull();
    expect((C as unknown as Record<string, number>)[name]).toBe(Number(m![1].replace(/_/g, "")));
  });
});
