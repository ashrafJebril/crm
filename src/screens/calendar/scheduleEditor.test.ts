import { describe, expect, it } from "vitest";
import { dayErrors, fromSchedule, hasErrors, reduce, serverError, toSchedule, type EditorModel } from "./scheduleEditor";
import { validateSchedule } from "./schedule";

describe("schedule editor round-trips and validates", () => {
  const start = () => fromSchedule({ sun: [{ from: "09:00", to: "17:00" }], tue: [{ from: "16:00", to: "21:00" }, { from: "09:00", to: "13:00" }] });

  it("round-trips the backend shape (input order kept, so error rows match)", () => {
    const m = start();
    expect(m.sun).toEqual({ on: true, windows: [{ from: "09:00", to: "17:00" }] });
    expect(m.mon).toEqual({ on: false, windows: [] });
    expect(toSchedule(m)).toEqual({ tue: [{ from: "16:00", to: "21:00" }, { from: "09:00", to: "13:00" }], sun: [{ from: "09:00", to: "17:00" }] });
    // The backend accepts it and returns the canonical form.
    expect(validateSchedule(toSchedule(m))).toEqual({
      ok: true,
      schedule: { tue: [{ from: "09:00", to: "13:00" }, { from: "16:00", to: "21:00" }], sun: [{ from: "09:00", to: "17:00" }] },
    });
  });

  it("toggle, add (≤ 3, after the last window), remove (last one turns the day off), set", () => {
    let m: EditorModel = start();
    m = reduce(m, { type: "toggle", day: "mon" });
    expect(m.mon).toEqual({ on: true, windows: [{ from: "09:00", to: "17:00" }] });
    m = reduce(m, { type: "add", day: "mon" });
    expect(m.mon.windows[1]).toEqual({ from: "17:00", to: "18:00" });
    m = reduce(m, { type: "add", day: "mon" });
    expect(m.mon.windows).toHaveLength(3);
    const same = reduce(m, { type: "add", day: "mon" });
    expect(same).toBe(m); // the 4th is refused
    m = reduce(m, { type: "set", day: "mon", index: 0, field: "to", value: "12:00" });
    expect(m.mon.windows[0]).toEqual({ from: "09:00", to: "12:00" });
    m = reduce(m, { type: "remove", day: "mon", index: 2 });
    m = reduce(m, { type: "remove", day: "mon", index: 1 });
    m = reduce(m, { type: "remove", day: "mon", index: 0 });
    expect(m.mon).toEqual({ on: false, windows: [] });
    // Toggling a day off keeps its windows for when it is turned back on, but does not send them.
    m = reduce(m, { type: "toggle", day: "sun" });
    expect(toSchedule(m)).not.toHaveProperty("sun");
    m = reduce(m, { type: "toggle", day: "sun" });
    expect(toSchedule(m).sun).toEqual([{ from: "09:00", to: "17:00" }]);
  });

  it("copy to other days copies windows and the on/off state; it never aliases", () => {
    let m = reduce(start(), { type: "copy", from: "sun", to: ["mon", "wed", "sun"] });
    expect(toSchedule(m).mon).toEqual([{ from: "09:00", to: "17:00" }]);
    m = reduce(m, { type: "set", day: "mon", index: 0, field: "from", value: "10:00" });
    expect(m.wed.windows[0].from).toBe("09:00");
    expect(m.sun.windows[0].from).toBe("09:00");
  });

  it("errors per day with the backend's reasons and the editor's row index", () => {
    let m = start();
    m = reduce(m, { type: "set", day: "tue", index: 1, field: "to", value: "17:00" }); // 09:00-17:00 overlaps 16:00-21:00
    m = reduce(m, { type: "set", day: "sun", index: 0, field: "to", value: "25:00" });
    expect(dayErrors(m)).toEqual({
      tue: { day: "tue", index: 0, reason: "overlap" },
      sun: { day: "sun", index: 0, reason: "time_invalid" },
    });
    expect(hasErrors(m)).toBe(true);
    m = reduce(m, { type: "toggle", day: "sun" }); // a day that is off is not checked
    expect(Object.keys(dayErrors(m))).toEqual(["tue"]);
  });

  it("reads the server's bookings.schedule_invalid body", () => {
    expect(serverError({ statusCode: 400, message: "bookings.schedule_invalid", day: "wed", index: 1, reason: "overlap" })).toEqual({
      wed: { day: "wed", index: 1, reason: "overlap" },
    });
    expect(serverError({ message: "bookings.schedule_invalid", day: null, index: null, reason: "not_object" })).toBeNull();
    expect(serverError({ message: "other" })).toBeNull();
  });
});
