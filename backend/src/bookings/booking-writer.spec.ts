/* eslint-disable @typescript-eslint/no-explicit-any */
import { HjzAppointmentSyncService } from "../hjz-sync/hjz-appointment-sync.service";
import { McpToolsFactory } from "../mcp-server/mcp-tools.factory";
import { AppointmentsService } from "../appointments/appointments.service";
import { A, booking, bookingWorld, failure, legacyInput, riyadh } from "./booking-test-world";

const catalog = (w: any, h: number, m = 0, over: Record<string, unknown> = {}) => ({
  contactId: "c1",
  serviceId: w.service.id,
  resourceId: w.resource.id,
  startAt: riyadh(h, m).toISOString(),
  status: "confirmed",
  source: "human",
  ...over,
});

describe("fit gate on create", () => {
  it("outside hours → 422 bookings.outside_schedule {fit}", async () => {
    const w = await bookingWorld();
    expect(await failure(w.appointments.create(A, catalog(w, 8, 30) as any))).toEqual({
      status: 422,
      body: {
        statusCode: 422,
        message: "bookings.outside_schedule",
        fit: { kind: "outside_hours", day: "tue", windows: [{ from: "09:00", to: "17:00" }] },
      },
    });
    // Friday 2027-01-08 is a day off.
    expect((await failure(w.appointments.create(A, catalog(w, 10, 0, { startAt: riyadh(10, 0, "2027-01-08").toISOString() }) as any))).body.fit).toEqual({
      kind: "off_day",
      day: "fri",
    });
    // Ending exactly at close fits.
    expect(await w.appointments.create(A, catalog(w, 16) as any)).toMatchObject({ fit: "ok", conflict: false });
    expect(w.prisma.db.appointment).toHaveLength(1);
  });

  it("the legacy staffId path is gated too (ruling 4)", async () => {
    const w = await bookingWorld();
    expect((await failure(w.appointments.create(A, legacyInput({ staffId: "uAgent", startAt: riyadh(7).toISOString() })))).status).toBe(422);
    const ok = await w.appointments.create(A, legacyInput({ staffId: "uAgent" }));
    expect(ok).toMatchObject({ resourceId: w.resource.id, staffId: "uAgent", serviceId: null, fit: "ok" });
  });

  it("an unconfigured schedule is not gated; final statuses are not gated", async () => {
    const w = await bookingWorld();
    const bare = await w.staff.create(A, { name: "Room", serviceIds: [w.service.id] });
    expect(await w.appointments.create(A, catalog(w, 3, 0, { resourceId: bare.id }) as any)).toMatchObject({ fit: "ok" });
    // Logging a past completed booking outside hours is allowed.
    expect(await w.appointments.create(A, catalog(w, 7, 0, { status: "completed" }) as any)).toMatchObject({ fit: "outside_hours" });
  });

  it("bypassFit skips fit and overlap; the row reads fit: outside_hours and conflict: true when overlapping", async () => {
    const w = await bookingWorld();
    const a = await w.appointments.create(A, catalog(w, 10) as any);
    const b = await w.appointments.create(A, catalog(w, 10, 30, { contactId: "c2" }) as any, { bypassFit: true });
    expect(b).toMatchObject({ conflict: true, fit: "ok" });
    const c = await w.appointments.create(A, catalog(w, 7, 0, { contactId: "c2" }) as any, { bypassFit: true });
    expect(c).toMatchObject({ fit: "outside_hours", conflict: false });
    const list = await w.appointments.list(A);
    expect(list.find((r: any) => r.id === a.id)).toMatchObject({ conflict: true, fit: "ok" });
  });

  it("archived service or resource → 400; unknown/foreign → 404; a resource not offering the service → 400", async () => {
    const w = await bookingWorld();
    const other = await w.staff.create(A, { name: "Lina", schedule: { tue: [{ from: "00:00", to: "24:00" }] } });
    expect((await failure(w.appointments.create(A, catalog(w, 10, 0, { resourceId: other.id }) as any))).body.message).toBe(
      "bookings.resource_not_offering",
    );
    expect((await failure(w.appointments.create(A, catalog(w, 10, 0, { serviceId: "nope" }) as any))).body.message).toBe(
      "bookings.service_not_found",
    );
    await w.staff.update(A, w.resource.id, { active: false });
    expect((await failure(w.appointments.create(A, catalog(w, 10) as any))).body.message).toBe("bookings.resource_archived");
    await w.staff.update(A, w.resource.id, { active: true });
    w.prisma.db.appointment.push(booking({ serviceId: w.service.id, status: "completed" }));
    await w.services.remove(A, w.service.id);
    expect(await failure(w.appointments.create(A, catalog(w, 10) as any))).toEqual({
      status: 400,
      body: { statusCode: 400, message: "bookings.service_archived" },
    });
  });

  it("no serviceId and no free-text service → 400 bookings.service_required", async () => {
    const w = await bookingWorld();
    expect((await failure(w.appointments.create(A, legacyInput({ service: undefined })))).body.message).toBe("bookings.service_required");
    expect((await failure(w.appointments.create(A, legacyInput({ durationMin: undefined })))).body.message).toBe("bookings.service_required");
  });
});

describe("catalog booking snapshots names and staff", () => {
  it("serviceId only → service/serviceAr/durationMin from the service, staffId from the resource's member", async () => {
    const w = await bookingWorld();
    const row = await w.appointments.create(A, catalog(w, 10) as any);
    expect(row).toMatchObject({
      serviceId: w.service.id,
      resourceId: w.resource.id,
      service: "Haircut",
      serviceAr: "قص شعر",
      durationMin: 60,
      staffId: "uAgent",
      version: 0,
    });
    // Given names and duration win over the service's.
    const custom = await w.appointments.create(A, catalog(w, 12, 0, { service: "Cut (long)", serviceAr: "قص طويل", durationMin: 90 }) as any);
    expect(custom).toMatchObject({ service: "Cut (long)", serviceAr: "قص طويل", durationMin: 90 });
  });

  it("changing the service re-snapshots names and duration; get() returns serviceRef and resource", async () => {
    const w = await bookingWorld();
    const beard = await w.services.create(A, { name: "Beard", nameAr: "لحية", durationMin: 30, color: "warn" });
    const row = await w.appointments.create(A, catalog(w, 10) as any);
    const moved = await w.appointments.update(A, row.id, { serviceId: beard.id });
    expect(moved).toMatchObject({ serviceId: beard.id, service: "Beard", serviceAr: "لحية", durationMin: 30, version: 1 });
    expect(await w.appointments.get(A, row.id)).toMatchObject({
      service: "Beard",
      serviceRef: { id: beard.id, name: "Beard", nameAr: "لحية", color: "warn" },
      resource: { id: w.resource.id, name: "Sara", nameAr: null },
      fit: "ok",
      conflict: false,
    });
  });
});

describe("stale reschedule returns 409 with current", () => {
  it("version mismatch → 409 bookings.version_conflict {current}; without version no check; version increments on every write", async () => {
    const w = await bookingWorld();
    const row = await w.appointments.create(A, catalog(w, 10) as any);
    expect(row.version).toBe(0);
    const v1 = await w.appointments.update(A, row.id, { startAt: riyadh(11).toISOString(), version: 0 });
    expect(v1.version).toBe(1);
    const stale = await failure(w.appointments.update(A, row.id, { startAt: riyadh(12).toISOString(), version: 0 }));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      message: "bookings.version_conflict",
      current: { id: row.id, version: 1, startAt: riyadh(11), fit: "ok", conflict: false },
    });
    // Legacy callers (no version) are not checked.
    expect((await w.appointments.update(A, row.id, { note: "x" })).version).toBe(2);
    expect((await w.appointments.update(A, row.id, { status: "completed" })).version).toBe(3);
  });

  it("two concurrent edits with the same version: one wins, the other gets the current row", async () => {
    const w = await bookingWorld({ locks: true });
    const row = await w.appointments.create(A, catalog(w, 10) as any);
    const results = await Promise.allSettled([
      w.appointments.update(A, row.id, { note: "one", version: 0 }),
      w.appointments.update(A, row.id, { note: "two", version: 0 }),
    ]);
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(lost).toHaveLength(1);
    expect(lost[0].reason.getResponse()).toMatchObject({ message: "bookings.version_conflict", current: { version: 1 } });
  });
});

describe("HJZ-linked rows are not re-gated without a time or resource change (ruling 5)", () => {
  it("a status or note change on an outside-hours HJZ row passes; moving it is gated", async () => {
    const w = await bookingWorld();
    w.prisma.db.appointment.push(
      booking({ id: "hjz1", contactId: "c1", resourceId: w.resource.id, staffId: "uAgent", status: "pending", startAt: riyadh(7), hjzAppointmentId: "H-1" }),
    );
    expect(await w.appointments.update(A, "hjz1", { status: "confirmed", note: "from HJZ" })).toMatchObject({
      status: "confirmed",
      fit: "outside_hours",
    });
    expect((await failure(w.appointments.update(A, "hjz1", { startAt: riyadh(6).toISOString() }))).status).toBe(422);
    expect(await w.appointments.update(A, "hjz1", { startAt: riyadh(9).toISOString() })).toMatchObject({ fit: "ok" });
  });
});

describe("hjz payload unchanged for catalog bookings", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.HJZ_API_URL;
    delete process.env.HJZ_WEBHOOK_SECRET;
  });

  it("a catalog booking's postToHjz payload equals the equivalent legacy booking's; changed() once per write", async () => {
    process.env.HJZ_API_URL = "http://hjz.local/api/v1";
    process.env.HJZ_WEBHOOK_SECRET = "s3cret";
    const bodies: any[] = [];
    global.fetch = jest.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ appointmentId: null }) } as any;
    }) as any;

    const w = await bookingWorld();
    w.prisma.raw = w.prisma;
    w.prisma.db.workspace.find((x: any) => x.id === A).externalTenantId = "tenant-1";
    Object.assign(w.prisma.db.user.find((u: any) => u.id === "uOwner"), { externalId: "hjz-u-1", kewyAccountId: null });
    const hjz = new HjzAppointmentSyncService(w.prisma as any);
    const changed = jest.spyOn(hjz, "changed");
    const appointments = new AppointmentsService(w.prisma as any, hjz);
    const settle = () => new Promise((r) => setTimeout(r, 30));

    // Legacy: free text, staffId of a member without a resource.
    const legacy = await appointments.create(A, legacyInput({ staffId: "uOwner", status: "confirmed" }));
    await settle();
    expect(changed).toHaveBeenCalledTimes(1);
    const legacyPayload = bodies.pop();
    await appointments.remove(A, legacy.id);
    bodies.length = 0;

    // Catalog: the same booking through a resource whose member is uOwner.
    const chair = await w.staff.create(A, { name: "Chair", userId: "uOwner", schedule: { tue: [{ from: "09:00", to: "17:00" }] }, serviceIds: [w.service.id] });
    const cat = await appointments.create(A, { contactId: "c1", serviceId: w.service.id, resourceId: chair.id, startAt: legacyInput().startAt, status: "confirmed", source: "human" } as any);
    await settle();
    expect(changed).toHaveBeenCalledTimes(2);
    const catalogPayload = bodies.pop();

    const strip = (p: any) => ({ ...p, appointment: { ...p.appointment, id: "x" } });
    expect(strip(catalogPayload)).toEqual(strip(legacyPayload));
    expect(Object.keys(catalogPayload.appointment).sort()).toEqual(
      ["contact", "durationMin", "id", "service", "serviceAr", "staff", "startAt", "status", "tenantId"],
    );
    expect(catalogPayload.appointment).toMatchObject({
      service: "Haircut",
      serviceAr: "قص شعر",
      durationMin: 60,
      status: "confirmed",
      staff: { hjzUserId: "hjz-u-1", kewyAccountId: null },
    });

    // One changed() per write (an update too).
    await appointments.update(A, cat.id, { status: "completed" });
    await settle();
    expect(changed).toHaveBeenCalledTimes(3);
  });
});

describe("mcp tools without catalog ids behave as before", () => {
  const tools = (w: any) => new McpToolsFactory(w.appointments, {} as never, {} as never, w.bookings).build(A);

  it("create/update/cancel with the existing inputs for a member without a resource", async () => {
    const w = await bookingWorld();
    const t = tools(w);
    const input = {
      contactId: "c1", service: "Cut", serviceAr: "قص", startAt: "2027-01-05T03:00:00+03:00",
      durationMin: 30, status: "pending", source: "self-booking", staffId: "uOwner", note: "by agent",
    };
    const created: any = await t.create_appointment.execute!(input as never, {} as never);
    expect(created).toMatchObject({
      contactId: "c1", service: "Cut", serviceAr: "قص", durationMin: 30, status: "pending", source: "self-booking",
      staffId: "uOwner", note: "by agent", serviceId: null, resourceId: null, fit: "unchecked",
    });
    expect(created.startAt.toISOString()).toBe("2027-01-05T00:00:00.000Z");
    const updated: any = await t.update_appointment.execute!({ id: created.id, startAt: "2027-01-05T23:00:00+03:00", status: "confirmed" } as never, {} as never);
    expect(updated).toMatchObject({ status: "confirmed", resourceId: null });
    const cancelled: any = await t.cancel_appointment.execute!({ id: created.id } as never, {} as never);
    expect(cancelled.status).toBe("cancelled");
  });

  it("mcp create goes through the same gate for a member with a resource", async () => {
    const w = await bookingWorld();
    const t = tools(w);
    await expect(
      t.create_appointment.execute!(
        { contactId: "c1", service: "Cut", serviceAr: "قص", startAt: "2027-01-05T07:00:00+03:00", durationMin: 30, status: "pending", source: "self-booking", staffId: "uAgent" } as never,
        {} as never,
      ),
    ).rejects.toThrow('bookings.outside_schedule {"fit":{"kind":"outside_hours"');
    await t.create_appointment.execute!(
      { contactId: "c1", serviceId: w.service.id, startAt: "2027-01-05T10:00:00+03:00", status: "pending", source: "self-booking", staffId: "uAgent" } as never,
      {} as never,
    );
    await expect(
      t.create_appointment.execute!(
        { contactId: "c2", serviceId: w.service.id, resourceId: w.resource.id, startAt: "2027-01-05T10:30:00+03:00", status: "pending", source: "self-booking" } as never,
        {} as never,
      ),
    ).rejects.toThrow("SLOT_TAKEN");
  });

  it("find_slots equals GET /bookings/availability; list_services lists active services only", async () => {
    const w = await bookingWorld();
    const everyDay = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [{ from: "09:00", to: "12:00" }]]));
    await w.staff.update(A, w.resource.id, { schedule: everyDay });
    const paused = await w.services.create(A, { name: "Paused", durationMin: 15 });
    await w.services.update(A, paused.id, { active: false });
    const t = tools(w);
    const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const viaTool = await t.find_slots.execute!({ serviceId: w.service.id, date } as never, {} as never);
    const viaRoute = await w.bookings.availability(A, { serviceId: w.service.id, date });
    // The tool groups the route's slots by start time (review R-M2).
    const byStart = new Map<string, string[]>();
    for (const s of viaRoute.slots) byStart.set(s.startAt, [...(byStart.get(s.startAt) ?? []), s.resourceId]);
    expect(viaTool).toEqual({ ...viaRoute, slots: [...byStart].map(([startAt, resourceIds]) => ({ startAt, resourceIds })) });
    expect((viaRoute as any).slots.length).toBeGreaterThan(0);
    expect(await t.list_services.execute!({} as never, {} as never)).toEqual([
      { id: w.service.id, name: "Haircut", nameAr: "قص شعر", durationMin: 60, price: "100.00", currency: "SAR" },
    ]);
  });
});
