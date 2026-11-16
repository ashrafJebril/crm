/** SP-10 booking calls (the shared client: token, 401, errors). */
import { api } from "@/api/client";
import type { Appointment, AppointmentStatus } from "@/lib/types";
import type { Slot } from "./slots";

export interface AvailabilityDto {
  date: string;
  tz: string;
  serviceId: string;
  durationMin: number;
  slots: Slot[];
  unconfigured: string[];
  truncated: boolean;
}

export interface BookingSearchItem {
  id: string;
  startAt: string;
  status: AppointmentStatus;
  contactId: string;
  contactName: string | null;
  service: string;
  serviceAr: string;
}

export interface NewBookingInput {
  contactId: string;
  serviceId?: string;
  resourceId?: string;
  staffId?: string;
  service?: string;
  serviceAr?: string;
  startAt: string;
  durationMin?: number;
  status: AppointmentStatus;
  source: "human";
  note?: string;
}

/**
 * A booking update. `resourceId` is sent only when the user changed it
 * (review R-M1): omitted = unchanged, null = drop the explicit resource.
 */
export interface BookingPatch {
  status?: AppointmentStatus;
  startAt?: string;
  durationMin?: number;
  serviceId?: string | null;
  resourceId?: string | null;
  version?: number;
}

export function availabilityPath(q: { serviceId: string; resourceId?: string | null; date: string }): string {
  const p = new URLSearchParams({ serviceId: q.serviceId, date: q.date });
  if (q.resourceId) p.set("resourceId", q.resourceId);
  return `/bookings/availability?${p.toString()}`;
}

export const getAvailability = (q: { serviceId: string; resourceId?: string | null; date: string }) =>
  api.get<AvailabilityDto>(availabilityPath(q));
export const createBooking = (body: NewBookingInput) => api.post<Appointment>("/appointments", body);
export const updateBooking = (id: string, body: BookingPatch) => api.patch<Appointment>(`/appointments/${id}`, body);
export const searchBookings = (q: string) =>
  api.get<{ items: BookingSearchItem[] }>(`/appointments/search?q=${encodeURIComponent(q)}`);

/** The reschedule body: only what changed, with the version the user saw. */
export function reschedulePatch(
  appt: Pick<Appointment, "startAt" | "durationMin" | "resourceId" | "version">,
  next: { startAt: string; durationMin?: number; resourceId?: string | null },
): BookingPatch {
  const body: BookingPatch = { version: appt.version ?? 0 };
  if (new Date(next.startAt).getTime() !== new Date(appt.startAt).getTime()) body.startAt = next.startAt;
  if (next.durationMin !== undefined && next.durationMin !== appt.durationMin) body.durationMin = next.durationMin;
  if (next.resourceId !== undefined && (next.resourceId ?? null) !== (appt.resourceId ?? null)) body.resourceId = next.resourceId;
  return body;
}
