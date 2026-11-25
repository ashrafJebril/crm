import { HttpException } from "@nestjs/common";
import { BOOKING_ERROR_KEYS, BOOKING_ERROR_STATUS, bookingError } from "./booking-errors";
import * as C from "./booking-constants";

describe("booking errors", () => {
  it("every key is bookings.* or SLOT_TAKEN", () => {
    for (const k of BOOKING_ERROR_KEYS) expect(k === "SLOT_TAKEN" || /^bookings\.[a-z_]+$/.test(k)).toBe(true);
  });

  it("carries the plan's statuses", () => {
    expect(BOOKING_ERROR_STATUS).toMatchObject({
      "bookings.service_not_found": 404,
      "bookings.resource_not_found": 404,
      "bookings.service_archived": 400,
      "bookings.resource_not_offering": 400,
      "bookings.date_invalid": 400,
      "bookings.range_invalid": 400,
      "bookings.service_required": 400,
      "bookings.schedule_invalid": 400,
      "bookings.not_a_member": 400,
      "bookings.member_has_resource": 409,
      "bookings.outside_schedule": 422,
      SLOT_TAKEN: 409,
      "bookings.illegal_transition": 409,
      "bookings.closed": 409,
      "bookings.version_conflict": 409,
    });
  });

  it.each(BOOKING_ERROR_KEYS)("%s builds an HttpException with the key as message", (key) => {
    const e = bookingError(key, { extra: 1 });
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(BOOKING_ERROR_STATUS[key]);
    expect(e.getResponse()).toEqual({ statusCode: BOOKING_ERROR_STATUS[key], message: key, extra: 1 });
  });
});

describe("booking constants", () => {
  it("match Global Constraints", () => {
    expect({
      SLOT_STEP_MIN: C.SLOT_STEP_MIN,
      MAX_DAYS_AHEAD: C.MAX_DAYS_AHEAD,
      MAX_WINDOWS_PER_DAY: C.MAX_WINDOWS_PER_DAY,
      MAX_LIST_RANGE_DAYS: C.MAX_LIST_RANGE_DAYS,
      SERVICE_DURATION_MIN: C.SERVICE_DURATION_MIN,
      SERVICE_DURATION_MAX: C.SERVICE_DURATION_MAX,
      MAX_PROPOSED_SERVICES: C.MAX_PROPOSED_SERVICES,
      MAX_PROPOSED_STAFF: C.MAX_PROPOSED_STAFF,
      MAX_CATALOG_SOURCE_CHARS: C.MAX_CATALOG_SOURCE_CHARS,
      MAX_CATALOG_FILE_ROWS: C.MAX_CATALOG_FILE_ROWS,
    }).toEqual({
      SLOT_STEP_MIN: 15,
      MAX_DAYS_AHEAD: 365,
      MAX_WINDOWS_PER_DAY: 3,
      MAX_LIST_RANGE_DAYS: 92,
      SERVICE_DURATION_MIN: 5,
      SERVICE_DURATION_MAX: 1440,
      MAX_PROPOSED_SERVICES: 100,
      MAX_PROPOSED_STAFF: 50,
      MAX_CATALOG_SOURCE_CHARS: 200_000,
      MAX_CATALOG_FILE_ROWS: 2_000,
    });
    expect([...C.BOOKING_COLORS]).toEqual(["ink", "info", "ok", "warn", "bad", "accent", "human"]);
  });

  it("price pattern accepts DECIMAL(12,2) strings only", () => {
    for (const ok of ["0", "12", "12.5", "12.50", "9999999999.99"]) expect(C.PRICE_PATTERN.test(ok)).toBe(true);
    for (const bad of ["-1", "1.234", "1e3", "", "12,50", "99999999999"]) expect(C.PRICE_PATTERN.test(bad)).toBe(false);
  });
});
