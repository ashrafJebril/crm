import { describe, expect, it } from "vitest";
import { calendarViewsFor, defaultCalendarView, explicitCalendarView, resolveCalendarView } from "./calendarView";

describe("calendar defaults to day view on phones", () => {
  it("phones open on the day view; md and up on the week", () => {
    expect(defaultCalendarView("phone")).toBe("day");
    expect(defaultCalendarView("tablet")).toBe("week");
    expect(defaultCalendarView("desktop")).toBe("week");
    expect(defaultCalendarView("wide")).toBe("week");
    expect(resolveCalendarView("phone", null)).toBe("day");
    expect(resolveCalendarView("tablet", null)).toBe("week");
  });

  it("a stored user choice wins on tablet and desktop (and on phones, except the week grid)", () => {
    for (const layout of ["tablet", "desktop", "wide"] as const) {
      for (const v of ["week", "day", "list", "agenda", "board"] as const) expect(resolveCalendarView(layout, v)).toBe(v);
    }
    expect(resolveCalendarView("phone", "agenda")).toBe("agenda");
    expect(resolveCalendarView("phone", "list")).toBe("list");
    expect(resolveCalendarView("phone", "week")).toBe("day");
    expect(explicitCalendarView("agenda")).toBe("agenda");
    expect(explicitCalendarView("month")).toBeNull();
    expect(explicitCalendarView(null)).toBeNull();
    expect(calendarViewsFor("phone")).not.toContain("week");
    expect(calendarViewsFor("tablet")).toContain("week");
  });
});
