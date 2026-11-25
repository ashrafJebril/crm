/**
 * SP-10 Task 2 spec helper (not a runtime file): the catalog world plus
 * contacts, a scheduled resource and the booking services over the
 * in-memory Prisma double.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { AppointmentsService } from "../appointments/appointments.service";
import { AppointmentsController } from "../appointments/appointments.controller";
import { BookingsService } from "./bookings.service";
import { A, B, catalogWorld } from "./catalog-test-world";

export { A, B, booking, failure } from "./catalog-test-world";

/** Sun–Thu 09:00–17:00 (Asia/Riyadh in workspace A). */
export const SUN_THU = {
  sun: [{ from: "09:00", to: "17:00" }],
  mon: [{ from: "09:00", to: "17:00" }],
  tue: [{ from: "09:00", to: "17:00" }],
  wed: [{ from: "09:00", to: "17:00" }],
  thu: [{ from: "09:00", to: "17:00" }],
};

/** 2027-01-05 is a Tuesday; Riyadh is UTC+3. `riyadh(9)` = 09:00 local. */
export const riyadh = (h: number, m = 0, date = "2027-01-05") =>
  new Date(`${date}T${String(h - 3).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`);

export async function bookingWorld(opts: { locks?: boolean; events?: { emit: jest.Mock }; hjz?: any } = {}) {
  const w = catalogWorld({ locks: opts.locks });
  w.prisma.db.contact = [
    { id: "c1", workspaceId: A, name: "ليلى أحمد", phone: "+966 50 123 4567", hjzClientId: null },
    { id: "c2", workspaceId: A, name: "Omar", phone: "+966500000002", hjzClientId: null },
    { id: "cB", workspaceId: B, name: "Other", phone: "+44700000000", hjzClientId: null },
  ];
  const appointments = new AppointmentsService(w.prisma as any, opts.hjz, opts.events as any);
  const bookings = new BookingsService(w.prisma as any);
  const controller = new AppointmentsController(appointments);
  // A catalog service offered by a scheduled resource whose member is uAgent.
  const service = await w.services.create(A, { name: "Haircut", nameAr: "قص شعر", durationMin: 60, price: "100" });
  const resource = await w.staff.create(A, { name: "Sara", userId: "uAgent", schedule: SUN_THU, serviceIds: [service.id] });
  return { ...w, appointments, bookings, controller, service, resource };
}

/** A legacy-shaped create body (no catalog ids). */
export function legacyInput(over: Record<string, unknown> = {}): any {
  return {
    contactId: "c1",
    service: "Haircut",
    serviceAr: "قص شعر",
    startAt: riyadh(10).toISOString(),
    durationMin: 60,
    status: "pending",
    source: "human",
    ...over,
  };
}
