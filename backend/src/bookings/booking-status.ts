/**
 * SP-10 booking lifecycle (Architecture → Transitions; ruling 8). Pure.
 * Frontend mirror: src/screens/calendar/bookingStatus.ts.
 *
 * The five stored values are kept (`no-show` with the hyphen). There is no
 * `rejected` (a declined request is `cancelled`) and no reopen of a final
 * booking. Enforced for every caller: REST, the MCP tools and internal code.
 */
import { bookingError } from "./booking-errors";

export const APPOINTMENT_STATUSES = ["pending", "confirmed", "completed", "cancelled", "no-show"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const BOOKING_ALLOWED: Record<AppointmentStatus, AppointmentStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["completed", "no-show", "cancelled"],
  completed: [],
  cancelled: [],
  "no-show": [],
};

/** Statuses that hold a slot: they block availability and overlap. */
export const OPEN_STATUSES: readonly AppointmentStatus[] = ["pending", "confirmed"];

export function isOpenStatus(status: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

export function allowedFrom(from: string): AppointmentStatus[] {
  return [...(BOOKING_ALLOWED[from as AppointmentStatus] ?? [])];
}

/**
 * A same-status write is a no-op (returns false). An allowed change returns
 * true. Anything else is 409 `bookings.illegal_transition {from, to, allowed}`.
 */
export function assertTransition(from: string, to: string): boolean {
  if (from === to) return false;
  const allowed = allowedFrom(from);
  if (!(allowed as string[]).includes(to)) throw bookingError("bookings.illegal_transition", { from, to, allowed });
  return true;
}
