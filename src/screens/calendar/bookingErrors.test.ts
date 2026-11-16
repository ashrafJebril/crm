import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
// The backend key lists are the fixtures (read as text; never compiled here).
import backendBookingErrors from "../../../backend/src/bookings/booking-errors.ts?raw";
import backendImportErrors from "../../../backend/src/catalog-import/catalog-import-errors.ts?raw";
import backendSchedule from "../../../backend/src/bookings/schedule.ts?raw";
import { BOOKING_ERROR_COPY, SCHEDULE_REASON_COPY, bookingErrorText, conflictCurrent } from "./bookingErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

function keysOf(src: string, table: string, re: RegExp): string[] {
  const m = new RegExp(`${table}[^=]*=\\s*\\{([\\s\\S]*?)\\}\\s*as const`).exec(src);
  if (!m) throw new Error(`${table} not found`);
  return [...m[1].matchAll(re)].map((x) => x[1]);
}

describe("booking error copy covers every SP-10 key in both languages", () => {
  const bookingKeys = keysOf(backendBookingErrors, "BOOKING_ERROR_STATUS", /^\s*"?((?:bookings\.[a-z_]+)|SLOT_TAKEN)"?\s*:/gm);
  const importKeys = keysOf(backendImportErrors, "CATALOG_IMPORT_ERROR_STATUS", /"(catalog_import\.[a-z_]+)"/g);

  it("the key lists match the backend exactly", () => {
    expect(bookingKeys.length).toBeGreaterThanOrEqual(21);
    expect(bookingKeys).toContain("SLOT_TAKEN");
    expect(importKeys.length).toBeGreaterThanOrEqual(14);
    const mine = Object.keys(BOOKING_ERROR_COPY).filter((k) => k.startsWith("bookings.") || k.startsWith("catalog_import.") || k === "SLOT_TAKEN");
    expect(mine.sort()).toEqual([...bookingKeys, ...importKeys].sort());
  });

  it.each([...keysOf(backendBookingErrors, "BOOKING_ERROR_STATUS", /^\s*"?((?:bookings\.[a-z_]+)|SLOT_TAKEN)"?\s*:/gm), ...keysOf(backendImportErrors, "CATALOG_IMPORT_ERROR_STATUS", /"(catalog_import\.[a-z_]+)"/g)])(
    "%s has distinct English and Arabic copy",
    (key) => {
      const err = new ApiError(key, 400, undefined, { statusCode: 400, message: key });
      const e = bookingErrorText(err, en);
      const a = bookingErrorText(err, ar);
      expect(e).not.toBe(key);
      expect(e).not.toMatch(ARABIC);
      expect(e).not.toMatch(/Something went wrong/);
      expect(a).toMatch(ARABIC);
    },
  );

  it("schedule reasons all have copy (the backend's list)", () => {
    const m = /export type ScheduleInvalidReason =([\s\S]*?);/.exec(backendSchedule);
    const reasons = [...m![1].matchAll(/"([a-z_0-9]+)"/g)].map((x) => x[1]);
    expect(Object.keys(SCHEDULE_REASON_COPY).sort()).toEqual(reasons.sort());
  });

  it("extras shape the copy: fit windows, day off, limits; 403 is the shared line", () => {
    const fit = new ApiError("bookings.outside_schedule", 422, undefined, {
      message: "bookings.outside_schedule",
      fit: { kind: "outside_hours", day: "tue", windows: [{ from: "09:00", to: "17:00" }] },
    });
    expect(bookingErrorText(fit, en)).toBe("Outside working hours (09:00–17:00).");
    const off = new ApiError("bookings.outside_schedule", 422, undefined, { message: "x", fit: { kind: "off_day", day: "fri" } });
    expect(bookingErrorText(off, ar)).toBe("الجمعة يوم عطلة لهذا الموظف.");
    const d = new ApiError("bookings.duration_invalid", 400, undefined, { message: "x", min: 1, max: 1440 });
    expect(bookingErrorText(d, en)).toBe("Duration must be between 1 and 1440 minutes.");
    expect(bookingErrorText(new ApiError("x", 403), en)).toMatch(/permission/);
    expect(bookingErrorText(new Error("weird"), en)).toBe("Something went wrong. Try again.");
  });

  it("reads the current row of a version conflict", () => {
    const err = new ApiError("bookings.version_conflict", 409, undefined, { message: "bookings.version_conflict", current: { id: "s1", version: 3 } });
    expect(conflictCurrent<{ version: number }>(err)).toEqual({ id: "s1", version: 3 });
    expect(conflictCurrent(new ApiError("SLOT_TAKEN", 409))).toBeNull();
  });
});
