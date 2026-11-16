/* eslint-disable @typescript-eslint/no-explicit-any */
import { AppointmentsService } from "./appointments.service";
import { BookingsController } from "../bookings/bookings.controller";
import { routesOf } from "../permissions/permission-map";
import { AppointmentsController } from "./appointments.controller";
import { A, B, booking, bookingWorld, failure, legacyInput, riyadh } from "../bookings/booking-test-world";

describe("AppointmentsService.list — filters", () => {
  let prisma: { appointment: { findMany: jest.Mock } };
  let svc: AppointmentsService;

  beforeEach(() => {
    prisma = { appointment: { findMany: jest.fn().mockResolvedValue([]) } };
    svc = new AppointmentsService(prisma as never);
  });

  const whereOf = () => prisma.appointment.findMany.mock.calls[0][0].where;

  it("filters by workspace only when no opts are given", async () => {
    await svc.list("ws1");
    expect(whereOf()).toEqual({ workspaceId: "ws1" });
  });

  it("filters by status", async () => {
    await svc.list("ws1", { status: "confirmed" });
    expect(whereOf()).toEqual({ workspaceId: "ws1", status: "confirmed" });
  });

  it("filters by a date range on startAt", async () => {
    await svc.list("ws1", { from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T00:00:00.000Z" });
    expect(whereOf()).toEqual({
      workspaceId: "ws1",
      startAt: { gte: new Date("2026-09-01T00:00:00.000Z"), lte: new Date("2026-09-30T00:00:00.000Z") },
    });
  });

  it("supports an open-ended 'from' with no 'to'", async () => {
    await svc.list("ws1", { from: "2026-09-01T00:00:00.000Z" });
    expect(whereOf()).toEqual({
      workspaceId: "ws1",
      startAt: { gte: new Date("2026-09-01T00:00:00.000Z"), lte: undefined },
    });
  });

  it("orders by startAt ascending, unchanged from before", async () => {
    await svc.list("ws1");
    expect(prisma.appointment.findMany.mock.calls[0][0].orderBy).toEqual({ startAt: "asc" });
  });
});

describe("AppointmentsService.update — appointment_completed trigger", () => {
  async function world() {
    const events = { emit: jest.fn() };
    const w = await bookingWorld({ events });
    w.prisma.db.contact.find((c: any) => c.id === "c1").phone = "962790000000";
    w.prisma.db.appointment.push(
      booking({ id: "a1", contactId: "c1", status: "confirmed", service: "Haircut", serviceAr: "قص شعر", startAt: new Date("2026-11-03T10:00:00.000Z"), durationMin: 30 }),
    );
    return { ...w, events };
  }

  it("fires when an appointment becomes completed, with the contact attached", async () => {
    const { appointments, events } = await world();
    await appointments.update(A, "a1", { status: "completed" });
    expect(events.emit).toHaveBeenCalledWith("workflow.trigger", {
      workspaceId: A,
      triggerType: "appointment_completed",
      payload: {
        appointment: {
          id: "a1",
          contactId: "c1",
          service: "Haircut",
          serviceAr: "قص شعر",
          startAt: "2026-11-03T10:00:00.000Z",
          durationMin: 30,
        },
        contact: { id: "c1", name: "ليلى أحمد", phone: "962790000000" },
      },
    });
  });

  it("does not fire again when an already-completed appointment is edited", async () => {
    const { appointments, events, prisma } = await world();
    prisma.db.appointment.find((a: any) => a.id === "a1").status = "completed";
    await appointments.update(A, "a1", { note: "tip" });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("does not fire for other status changes", async () => {
    const { appointments, events } = await world();
    await appointments.update(A, "a1", { status: "cancelled" });
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("appointment list filters, annotations and search", () => {
  async function world() {
    const w = await bookingWorld();
    const beard = await w.services.create(A, { name: "Beard trim", nameAr: "تهذيب اللحية", durationMin: 30 });
    const r2 = await w.staff.create(A, { name: "Lina", schedule: { tue: [{ from: "09:00", to: "17:00" }] }, serviceIds: [beard.id] });
    const rows = [
      booking({ id: "b1", contactId: "c1", serviceId: w.service.id, resourceId: w.resource.id, staffId: "uAgent", status: "confirmed", startAt: riyadh(10) }),
      booking({ id: "b2", contactId: "c2", staffId: "uAgent", status: "pending", startAt: riyadh(10, 30), service: "Walk-in", serviceAr: "حضور" }),
      booking({ id: "b3", contactId: "c2", serviceId: beard.id, resourceId: r2.id, status: "completed", startAt: riyadh(7), service: "Beard trim", serviceAr: "تهذيب اللحية", durationMin: 30 }),
      booking({ id: "b4", contactId: "c1", status: "cancelled", startAt: riyadh(10), service: "Haircut", serviceAr: "قص شعر" }),
      booking({ id: "bB", workspaceId: B, contactId: "cB", status: "confirmed", startAt: riyadh(10) }),
    ];
    w.prisma.db.appointment.push(...rows);
    return { ...w, beard, r2 };
  }

  it("the no-param response is every booking of the workspace plus the SP-10 fields", async () => {
    const w = await world();
    const all = await w.appointments.list(A);
    expect(all.map((r: any) => r.id)).toEqual(["b3", "b1", "b4", "b2"]);
    for (const r of all) {
      const raw = w.prisma.db.appointment.find((x: any) => x.id === r.id);
      expect(r).toEqual({ ...raw, conflict: expect.any(Boolean), fit: expect.any(String) });
    }
  });

  it("conflict and fit flags: legacy rows of the member conflict with the resource's; fit unchecked without a resource", async () => {
    const w = await world();
    const byId = Object.fromEntries((await w.appointments.list(A)).map((r: any) => [r.id, r]));
    expect(byId.b1).toMatchObject({ conflict: true, fit: "ok" });
    expect(byId.b2).toMatchObject({ conflict: true, fit: "unchecked" });
    expect(byId.b3).toMatchObject({ conflict: false, fit: "outside_hours" });
    expect(byId.b4).toMatchObject({ conflict: false, fit: "unchecked" }); // cancelled never conflicts
    // A filtered list computes the same flags against bookings outside the filter.
    const filtered = await w.appointments.list(A, { resourceId: w.resource.id });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ id: "b1", conflict: true });
  });

  it("range ≤ 92 days (400 bookings.range_invalid beyond or reversed); status, serviceId, resourceId and limit", async () => {
    const w = await world();
    const from = "2027-01-01T00:00:00.000Z";
    expect(await failure(w.appointments.list(A, { from, to: "2027-04-04T00:00:00.000Z" }))).toEqual({
      status: 400,
      body: { statusCode: 400, message: "bookings.range_invalid", maxDays: 92 },
    });
    expect((await failure(w.appointments.list(A, { from, to: "2026-12-01T00:00:00.000Z" }))).body.message).toBe("bookings.range_invalid");
    const ids = async (o: any) => (await w.appointments.list(A, o)).map((r: any) => r.id);
    expect(await ids({ from, to: "2027-04-02T00:00:00.000Z" })).toEqual(["b3", "b1", "b4", "b2"]);
    expect(await ids({ status: "confirmed" })).toEqual(["b1"]);
    expect(await ids({ status: "pending,confirmed" })).toEqual(["b1", "b2"]);
    expect(await ids({ serviceId: w.beard.id })).toEqual(["b3"]);
    expect(await ids({ resourceId: w.r2.id })).toEqual(["b3"]);
    expect(await ids({ limit: 2 })).toEqual(["b3", "b1"]);
  });

  it("search by Arabic name with and without hamza, by phone digits and by service name; ≤ 10; short q → []", async () => {
    const w = await world();
    const ids = async (q: string) => (await w.appointments.search(A, q)).items.map((r) => r.id).sort();
    expect(await ids("أحمد")).toEqual(["b1", "b4"]);
    expect(await ids("احمد")).toEqual(["b1", "b4"]);
    expect(await ids("ليلي")).toEqual(["b1", "b4"]); // ى/ي
    expect(await ids("123 45")).toEqual(["b1", "b4"]); // phone digits, any formatting
    expect(await ids("beard")).toEqual(["b3"]);
    expect(await ids("اللحيه")).toEqual(["b3"]); // ة/ه
    expect(await ids("omar")).toEqual(["b2", "b3"]);
    expect(await ids("x")).toEqual([]);
    expect(await ids(" ")).toEqual([]);
    expect(await ids("Other")).toEqual([]); // workspace B's contact
    const item = (await w.appointments.search(A, "beard")).items[0];
    expect(item).toEqual({
      id: "b3", startAt: riyadh(7), status: "completed", contactId: "c2", contactName: "Omar", service: "Beard trim", serviceAr: "تهذيب اللحية",
    });
    for (let i = 0; i < 15; i++) w.prisma.db.appointment.push(booking({ contactId: "c2", startAt: riyadh(9, i) }));
    expect((await w.appointments.search(A, "omar")).items).toHaveLength(10);
  });

  it("search is declared before :id (route order)", () => {
    const keys = routesOf(AppointmentsController).map((r) => r.key);
    expect(keys.indexOf("GET /appointments/search")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("GET /appointments/search")).toBeLessThan(keys.indexOf("GET /appointments/:id"));
  });
});

describe("foreign ids return 404 on SP-10 booking routes", () => {
  it("availability with workspace B's service or resource ids", async () => {
    const w = await bookingWorld();
    const svcB = await w.services.create(B, { name: "B cut", durationMin: 30 });
    const resB = await w.staff.create(B, { name: "B chair", serviceIds: [svcB.id] });
    const ctrl = new BookingsController(w.bookings);
    const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(await failure(ctrl.availability(A, { serviceId: svcB.id, date }))).toEqual({
      status: 404,
      body: { statusCode: 404, message: "bookings.service_not_found" },
    });
    expect(await failure(ctrl.availability(A, { serviceId: w.service.id, resourceId: resB.id, date }))).toEqual({
      status: 404,
      body: { statusCode: 404, message: "bookings.resource_not_found" },
    });
  });

  it("POST/PATCH with B's serviceId, resourceId or contact; GET/PATCH/DELETE of B's booking", async () => {
    const w = await bookingWorld();
    const svcB = await w.services.create(B, { name: "B cut", durationMin: 30 });
    const resB = await w.staff.create(B, { name: "B chair", serviceIds: [svcB.id] });
    const mine = await w.controller.create(A, legacyInput());
    const key = async (p: Promise<unknown>) => {
      const r = await failure(p);
      return [r.status, r.body.message];
    };
    expect(await key(w.controller.create(A, { ...legacyInput(), serviceId: svcB.id }))).toEqual([404, "bookings.service_not_found"]);
    expect(await key(w.controller.create(A, { ...legacyInput(), resourceId: resB.id }))).toEqual([404, "bookings.resource_not_found"]);
    expect(await key(w.controller.create(A, legacyInput({ contactId: "cB" })))).toEqual([404, "Contact not found"]);
    expect(await key(w.controller.update(A, mine.id, { serviceId: svcB.id }))).toEqual([404, "bookings.service_not_found"]);
    expect(await key(w.controller.update(A, mine.id, { resourceId: resB.id }))).toEqual([404, "bookings.resource_not_found"]);
    w.prisma.db.appointment.push(booking({ id: "theirs", workspaceId: B, contactId: "cB" }));
    expect(await key(w.controller.get(A, "theirs"))).toEqual([404, "Appointment not found"]);
    expect(await key(w.controller.update(A, "theirs", { note: "x" }))).toEqual([404, "Appointment not found"]);
    expect(await key(w.controller.remove(A, "theirs"))).toEqual([404, "Appointment not found"]);
    expect(w.prisma.db.appointment.find((a: any) => a.id === "theirs")).toMatchObject({ workspaceId: B });
  });
});
