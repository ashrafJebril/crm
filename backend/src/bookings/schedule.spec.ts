import { HttpException } from "@nestjs/common";
import { isConfigured, readSchedule, scheduleFit, scheduleFitAt, validateSchedule, type WeeklySchedule } from "./schedule";

const SUN_THU: WeeklySchedule = {
  sun: [{ from: "09:00", to: "17:00" }],
  mon: [{ from: "09:00", to: "17:00" }],
  tue: [{ from: "09:00", to: "17:00" }],
  wed: [{ from: "09:00", to: "17:00" }],
  thu: [{ from: "09:00", to: "17:00" }],
};
const RIYADH = "Asia/Riyadh"; // UTC+3, no DST
const LONDON = "Europe/London"; // UTC+0 in November

const at = (iso: string) => new Date(iso);

describe("schedule-fit rejects outside hours in workspace TZ", () => {
  it("09:00 local Tuesday for 60 min fits (Asia/Riyadh)", () => {
    expect(scheduleFitAt(SUN_THU, at("2026-11-17T06:00:00Z"), 60, RIYADH)).toEqual({ kind: "ok" });
  });

  it("08:30 local is outside hours, with the day's windows", () => {
    expect(scheduleFitAt(SUN_THU, at("2026-11-17T05:30:00Z"), 60, RIYADH)).toEqual({
      kind: "outside_hours",
      day: "tue",
      windows: [{ from: "09:00", to: "17:00" }],
    });
  });

  it("16:30-17:30 local is outside hours; 16:00-17:00 ends at close and fits", () => {
    expect(scheduleFitAt(SUN_THU, at("2026-11-17T13:30:00Z"), 60, RIYADH).kind).toBe("outside_hours");
    expect(scheduleFitAt(SUN_THU, at("2026-11-17T13:00:00Z"), 60, RIYADH)).toEqual({ kind: "ok" });
  });

  it("Friday 10:00 local is a day off", () => {
    // 2026-11-20 is a Friday; 10:00 Riyadh = 07:00Z.
    expect(scheduleFitAt(SUN_THU, at("2026-11-20T07:00:00Z"), 60, RIYADH)).toEqual({ kind: "off_day", day: "fri" });
  });

  it("the same instants in Europe/London give London-local answers (never UTC, never the server zone)", () => {
    // 06:00Z = 06:00 London: before opening.
    expect(scheduleFitAt(SUN_THU, at("2026-11-17T06:00:00Z"), 60, LONDON).kind).toBe("outside_hours");
    // 13:30Z = 13:30 London: inside 09-17.
    expect(scheduleFitAt(SUN_THU, at("2026-11-17T13:30:00Z"), 60, LONDON)).toEqual({ kind: "ok" });
    // 16:30Z for 60 min = 16:30-17:30 London: outside.
    expect(scheduleFitAt(SUN_THU, at("2026-11-17T16:30:00Z"), 60, LONDON).kind).toBe("outside_hours");
    // Friday 07:00Z: a day off in London too.
    expect(scheduleFitAt(SUN_THU, at("2026-11-20T07:00:00Z"), 60, LONDON)).toEqual({ kind: "off_day", day: "fri" });
    // Thursday 22:00Z is Friday 01:00 in Riyadh but Thursday 22:00 in London.
    expect(scheduleFitAt(SUN_THU, at("2026-11-19T22:00:00Z"), 60, RIYADH)).toEqual({ kind: "off_day", day: "fri" });
    expect(scheduleFitAt(SUN_THU, at("2026-11-19T22:00:00Z"), 60, LONDON)).toEqual({
      kind: "outside_hours",
      day: "thu",
      windows: [{ from: "09:00", to: "17:00" }],
    });
  });

  it("two windows 09:00-13:00 and 16:00-21:00: 12:30-13:30 must fit one window", () => {
    const split: WeeklySchedule = { tue: [{ from: "09:00", to: "13:00" }, { from: "16:00", to: "21:00" }] };
    expect(scheduleFitAt(split, at("2026-11-17T09:30:00Z"), 60, RIYADH)).toEqual({
      kind: "outside_hours",
      day: "tue",
      windows: [
        { from: "09:00", to: "13:00" },
        { from: "16:00", to: "21:00" },
      ],
    });
    expect(scheduleFitAt(split, at("2026-11-17T13:00:00Z"), 60, RIYADH)).toEqual({ kind: "ok" }); // 16:00-17:00
    // Contiguous windows still do not merge: a booking over the seam is outside.
    const seam: WeeklySchedule = { tue: [{ from: "09:00", to: "13:00" }, { from: "13:00", to: "17:00" }] };
    expect(scheduleFitAt(seam, at("2026-11-17T09:30:00Z"), 60, RIYADH).kind).toBe("outside_hours");
  });

  it("a booking 23:30-00:30 local crosses midnight and is outside hours", () => {
    const allDay: WeeklySchedule = { tue: [{ from: "00:00", to: "24:00" }], wed: [{ from: "00:00", to: "24:00" }] };
    // 23:30 Riyadh on Tue = 20:30Z.
    expect(scheduleFitAt(allDay, at("2026-11-17T20:30:00Z"), 60, RIYADH).kind).toBe("outside_hours");
    // 23:00-24:00 ends exactly at midnight and fits.
    expect(scheduleFitAt(allDay, at("2026-11-17T20:00:00Z"), 60, RIYADH)).toEqual({ kind: "ok" });
  });

  it("an unconfigured schedule fits everything", () => {
    expect(scheduleFitAt({}, at("2026-11-20T23:30:00Z"), 600, RIYADH)).toEqual({ kind: "ok" });
    expect(scheduleFitAt({ mon: [] }, at("2026-11-17T02:00:00Z"), 60, RIYADH)).toEqual({ kind: "ok" });
    expect(scheduleFitAt(null, at("2026-11-17T02:00:00Z"), 60, RIYADH)).toEqual({ kind: "ok" });
    expect(isConfigured({})).toBe(false);
    expect(isConfigured({ sat: [] })).toBe(false);
    expect(isConfigured(SUN_THU)).toBe(true);
  });

  it("an invalid workspace zone falls back to Asia/Riyadh", () => {
    expect(scheduleFitAt(SUN_THU, at("2026-11-17T06:00:00Z"), 60, "Not/AZone")).toEqual({ kind: "ok" });
  });

  it("pure scheduleFit takes a local span", () => {
    expect(scheduleFit(SUN_THU, { dateISO: "2026-11-17", startMin: 540, endMin: 600 })).toEqual({ kind: "ok" });
    expect(scheduleFit(SUN_THU, { dateISO: "2026-11-17", startMin: 1000, endMin: 1030 }).kind).toBe("outside_hours");
  });
});

function errOf(fn: () => unknown): { status: number; body: Record<string, unknown> } {
  try {
    fn();
  } catch (e) {
    const h = e as HttpException;
    return { status: h.getStatus(), body: h.getResponse() as Record<string, unknown> };
  }
  throw new Error("expected a throw");
}

describe("validateSchedule rejects malformed schedules", () => {
  const cases: [string, unknown, { day: string | null; index: number | null; reason: string }][] = [
    ["not an object", [], { day: null, index: null, reason: "not_object" }],
    ["null", null, { day: null, index: null, reason: "not_object" }],
    ["unknown day key", { monday: [] }, { day: "monday", index: null, reason: "unknown_day" }],
    ["non-array day", { mon: { from: "09:00", to: "10:00" } }, { day: "mon", index: null, reason: "not_array" }],
    [
      "4 windows",
      {
        tue: [
          { from: "08:00", to: "09:00" },
          { from: "10:00", to: "11:00" },
          { from: "12:00", to: "13:00" },
          { from: "14:00", to: "15:00" },
        ],
      },
      { day: "tue", index: 3, reason: "too_many_windows" },
    ],
    ["window not an object", { wed: ["09:00-10:00"] }, { day: "wed", index: 0, reason: "window_invalid" }],
    ["25:00", { thu: [{ from: "09:00", to: "25:00" }] }, { day: "thu", index: 0, reason: "time_invalid" }],
    ["24:30", { thu: [{ from: "09:00", to: "24:30" }] }, { day: "thu", index: 0, reason: "time_invalid" }],
    ["9:00 (no padding)", { thu: [{ from: "9:00", to: "10:00" }] }, { day: "thu", index: 0, reason: "time_invalid" }],
    ["minutes 60", { thu: [{ from: "09:60", to: "10:00" }] }, { day: "thu", index: 0, reason: "time_invalid" }],
    ["missing to", { thu: [{ from: "09:00" }] }, { day: "thu", index: 0, reason: "time_invalid" }],
    ["24:00 as a start", { fri: [{ from: "24:00", to: "24:00" }] }, { day: "fri", index: 0, reason: "start_at_24" }],
    ["from == to", { sat: [{ from: "10:00", to: "10:00" }] }, { day: "sat", index: 0, reason: "from_not_before_to" }],
    ["from > to (overnight)", { sat: [{ from: "22:00", to: "02:00" }] }, { day: "sat", index: 0, reason: "from_not_before_to" }],
    [
      "overlapping windows",
      { sun: [{ from: "12:00", to: "15:00" }, { from: "09:00", to: "12:30" }] },
      { day: "sun", index: 1, reason: "overlap" },
    ],
  ];

  it.each(cases)("%s → 400 bookings.schedule_invalid", (_name, input, detail) => {
    const { status, body } = errOf(() => validateSchedule(input));
    expect(status).toBe(400);
    expect(body).toEqual({ statusCode: 400, message: "bookings.schedule_invalid", ...detail });
  });

  it("a valid schedule is returned sorted, canonical and with empty days dropped", () => {
    const out = validateSchedule({
      wed: [
        { from: "16:00", to: "21:00", extra: "ignored" },
        { from: "09:00", to: "13:00" },
      ],
      mon: [{ from: "00:00", to: "24:00" }],
      sun: [],
      tue: [
        { from: "13:00", to: "17:00" },
        { from: "09:00", to: "13:00" },
      ],
    });
    expect(out).toEqual({
      mon: [{ from: "00:00", to: "24:00" }],
      tue: [
        { from: "09:00", to: "13:00" },
        { from: "13:00", to: "17:00" },
      ],
      wed: [
        { from: "09:00", to: "13:00" },
        { from: "16:00", to: "21:00" },
      ],
    });
    expect(Object.keys(out)).toEqual(["mon", "tue", "wed"]);
    expect(validateSchedule({})).toEqual({});
  });

  it("readSchedule never throws: a malformed stored value is unconfigured", () => {
    expect(readSchedule("garbage")).toEqual({});
    expect(readSchedule({ mon: [{ from: "x", to: "y" }] })).toEqual({});
    expect(readSchedule(SUN_THU)).toEqual(SUN_THU);
  });
});
