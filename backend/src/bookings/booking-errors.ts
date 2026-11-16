import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

/**
 * SP-10 booking error keys. The `message` is the key itself (the frontend
 * maps it through `tx` in `src/screens/calendar/bookingErrors.ts`); extras
 * ride along. Same shape as `ticketError` / `channelError`.
 * `SLOT_TAKEN` keeps the roadmap's name.
 */
export const BOOKING_ERROR_STATUS = {
  // Catalog (Task 1)
  "bookings.name_required": 400,
  "bookings.duration_invalid": 400, // {min, max}
  "bookings.price_invalid": 400,
  "bookings.currency_invalid": 400,
  "bookings.color_invalid": 400, // {allowed}
  "bookings.schedule_invalid": 400, // {day, index, reason}
  "bookings.not_a_member": 400,
  "bookings.member_has_resource": 409, // {resourceId}
  "bookings.version_conflict": 409, // {current}
  "bookings.service_not_found": 404,
  "bookings.resource_not_found": 404,
  "bookings.resource_archived": 400,
  // Booking engine (Task 2)
  "bookings.service_archived": 400,
  "bookings.resource_not_offering": 400,
  "bookings.service_required": 400,
  "bookings.date_invalid": 400,
  "bookings.range_invalid": 400,
  "bookings.outside_schedule": 422, // {fit}
  "bookings.illegal_transition": 409, // {from, to, allowed}
  "bookings.closed": 409,
  SLOT_TAKEN: 409, // {conflict: {id, startAt, durationMin, status}}
} as const;

export type BookingErrorKey = keyof typeof BOOKING_ERROR_STATUS;

export const BOOKING_ERROR_KEYS = Object.keys(BOOKING_ERROR_STATUS) as BookingErrorKey[];

export function bookingError(key: BookingErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = BOOKING_ERROR_STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 404) return new NotFoundException(body);
  if (statusCode === 409) return new ConflictException(body);
  if (statusCode === 422) return new UnprocessableEntityException(body);
  return new BadRequestException(body);
}
