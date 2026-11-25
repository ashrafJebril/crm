/* eslint-disable @typescript-eslint/no-explicit-any */
import { MAX_SLOTS, generateSlots } from "./availability";
import { A, B, booking, bookingWorld, failure } from "./booking-test-world";

const TUE = "2026-11-17"; // a Tuesday
const NOW = new Date("2026-11-16T08:00:00Z"); // the day before
const NINE_TO_NOON = {
  sun: [{ from: "09:00", to: "12:00" }],
  mon: [{ from: "09:00", to: "12:00" }],
  tue: [{ from: "09:00", to: "12:00" }],
  wed: [{ from: "09:00", to: "12:00" }],
  thu: [{ from: "09:00", to: "12:00" }],
};
const local = (iso: string) => iso.slice(11, 16);

async function world() {
  const w = await bookingWorld();
  await w.staff.update(A, w.resource.id, { schedule: NINE_TO_NOON });
  return w;
}

describe("availability uses the workspace day", () => {
  it("60-min service, Sun–Thu 09:00–12:00 Asia/Riyadh, one confirmed 10:00–11:00 → exactly [09:00, 11:00]", async () => {
    const w = await world();
    w.prisma.db.appointment.push(
      booking({ resourceId: w.resource.id, staffId: "uAgent", status: "confirmed", startAt: new Date("2026-11-17T07:00:00Z"), durationMin: 60 }),
    );
    const out = await w.bookings.availability(A, { serviceId: w.service.id, date: TUE }, NOW);
    expect(out).toEqual({
      date: TUE,
      tz: "Asia/Riyadh",
      serviceId: w.service.id,
      durationMin: 60,
      slots: [
        { startAt: "2026-11-17T09:00:00+03:00", resourceId: w.resource.id },
        { startAt: "2026-11-17T11:00:00+03:00", resourceId: w.resource.id },
      ],
      unconfigured: [],
      truncated: false,
    });
  });

  it("the day is the workspace's local day (London workspace: 09:00 London = 09:00Z)", async () => {
    const w = await world();
    const svcB = await w.services.create(B, { name: "Cut", durationMin: 60 });
    const resB = await w.staff.create(B, { name: "Tom", schedule: NINE_TO_NOON, serviceIds: [svcB.id] });
    const out = await w.bookings.availability(B, { serviceId: svcB.id, date: TUE }, NOW);
    expect(out.tz).toBe("Europe/London");
    expect(out.slots.map((s) => s.startAt)).toEqual([
      "2026-11-17T09:00:00+00:00",
      "2026-11-17T09:15:00+00:00",
      "2026-11-17T09:30:00+00:00",
      "2026-11-17T09:45:00+00:00",
      "2026-11-17T10:00:00+00:00",
      "2026-11-17T10:15:00+00:00",
      "2026-11-17T10:30:00+00:00",
      "2026-11-17T10:45:00+00:00",
      "2026-11-17T11:00:00+00:00",
    ]);
    expect(new Set(out.slots.map((s) => s.resourceId))).toEqual(new Set([resB.id]));
  });

  it("a date in the past or more than 365 days ahead, or malformed, is 400 bookings.date_invalid", async () => {
    const w = await world();
    for (const date of ["2026-11-15", "2027-11-17", "2026-13-01", "17-11-2026"]) {
      const r = await failure(w.bookings.availability(A, { serviceId: w.service.id, date }, NOW));
      expect({ date, status: r.status, key: r.body.message }).toEqual({ date, status: 400, key: "bookings.date_invalid" });
    }
    // Today and exactly 365 days ahead are fine.
    await expect(w.bookings.availability(A, { serviceId: w.service.id, date: "2026-11-16" }, NOW)).resolves.toBeDefined();
    await expect(w.bookings.availability(A, { serviceId: w.service.id, date: "2027-11-16" }, NOW)).resolves.toBeDefined();
  });

  it("a resource not offering the service is 400 bookings.resource_not_offering", async () => {
    const w = await world();
    const other = await w.staff.create(A, { name: "Lina", schedule: NINE_TO_NOON });
    expect(await failure(w.bookings.availability(A, { serviceId: w.service.id, resourceId: other.id, date: TUE }, NOW))).toEqual({
      status: 400,
      body: { statusCode: 400, message: "bookings.resource_not_offering" },
    });
    // The resource filter limits slots to that resource.
    const only = await w.bookings.availability(A, { serviceId: w.service.id, resourceId: w.resource.id, date: TUE }, NOW);
    expect(only.slots).toHaveLength(9);
  });

  it("archived or paused services and resources offer nothing", async () => {
    const w = await world();
    await w.staff.update(A, w.resource.id, { active: false });
    expect((await w.bookings.availability(A, { serviceId: w.service.id, date: TUE }, NOW)).slots).toEqual([]);
    await w.staff.update(A, w.resource.id, { active: true });
    await w.services.update(A, w.service.id, { active: false });
    expect((await w.bookings.availability(A, { serviceId: w.service.id, date: TUE }, NOW)).slots).toEqual([]);
    await w.services.update(A, w.service.id, { active: true });
    w.prisma.db.appointment.push(booking({ serviceId: w.service.id, status: "completed", startAt: new Date("2026-11-01T07:00:00Z") }));
    await w.services.remove(A, w.service.id); // archived (it has a booking)
    expect((await w.bookings.availability(A, { serviceId: w.service.id, date: TUE }, NOW)).slots).toEqual([]);
  });

  it("unconfigured lists resources with no schedule (they offer no slots)", async () => {
    const w = await world();
    const bare = await w.staff.create(A, { name: "New", serviceIds: [w.service.id] });
    const out = await w.bookings.availability(A, { serviceId: w.service.id, date: TUE }, NOW);
    expect(out.unconfigured).toEqual([bare.id]);
    expect(out.slots.every((s) => s.resourceId === w.resource.id)).toBe(true);
  });

  it("now in the middle of the day drops past starts; off days have no slots", async () => {
    const w = await world();
    const midday = new Date("2026-11-17T07:20:00Z"); // 10:20 Riyadh
    const out = await w.bookings.availability(A, { serviceId: w.service.id, date: TUE }, midday);
    expect(out.slots.map((s) => local(s.startAt))).toEqual(["10:30", "10:45", "11:00"]);
    // 2026-11-20 is a Friday (off).
    expect((await w.bookings.availability(A, { serviceId: w.service.id, date: "2026-11-20" }, NOW)).slots).toEqual([]);
  });

  it("cancelled and no-show bookings do not block; pending does; back-to-back is fine", async () => {
    const w = await world();
    w.prisma.db.appointment.push(
      booking({ resourceId: w.resource.id, status: "cancelled", startAt: new Date("2026-11-17T06:00:00Z") }),
      booking({ resourceId: w.resource.id, status: "no-show", startAt: new Date("2026-11-17T07:00:00Z") }),
      booking({ resourceId: w.resource.id, status: "pending", startAt: new Date("2026-11-17T08:00:00Z") }), // 11:00-12:00
    );
    const out = await w.bookings.availability(A, { serviceId: w.service.id, date: TUE }, NOW);
    expect(out.slots.map((s) => local(s.startAt))).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00"]);
  });

  it("generateSlots: DST spring-forward day in New York never produces a slot inside the gap or twice", () => {
    const { slots } = generateSlots({
      dateISO: "2026-03-08",
      tz: "America/New_York",
      durationMin: 30,
      now: new Date("2026-03-01T00:00:00Z"),
      resources: [{ id: "r", schedule: { sun: [{ from: "01:00", to: "04:00" }] }, busy: [] }],
    });
    const iso = slots.map((s) => s.startAt.toISOString());
    expect(new Set(iso).size).toBe(iso.length);
    const walls = slots.map((s) =>
      new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(s.startAt),
    );
    // 02:00-02:59 does not exist that day; the 02:xx steps resolve forward and dedupe.
    expect(walls).toEqual(["01:00", "01:15", "01:30", "01:45", "03:00", "03:15", "03:30"]);
    expect(iso[0]).toBe("2026-03-08T06:00:00.000Z");
  });

  it("returns every slot of a real day; only a hard cap far above that truncates, and says so (review I2)", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `r${String(i).padStart(3, "0")}`,
        schedule: { tue: [{ from: "00:00", to: "24:00" }] },
        busy: [],
      }));
    const ten = generateSlots({ dateISO: TUE, tz: "Asia/Riyadh", durationMin: 15, now: NOW, resources: many(10) });
    expect(ten.slots).toHaveLength(960);
    expect(ten.truncated).toBe(false);
    const huge = generateSlots({ dateISO: TUE, tz: "Asia/Riyadh", durationMin: 15, now: NOW, resources: many(120) });
    expect(huge.slots).toHaveLength(MAX_SLOTS);
    expect(huge.truncated).toBe(true);
  });
});

describe("reschedule availability: the booking itself and its own duration (final review M2, M5)", () => {
  it("excludeAppointmentId ignores that booking, so its own time and overlapping times are offered", async () => {
    const w = await world();
    w.prisma.db.appointment.push(
      booking({ id: "mine", resourceId: w.resource.id, staffId: "uAgent", status: "confirmed", startAt: new Date("2026-11-17T07:00:00Z"), durationMin: 60 }),
    );
    const without = await w.bookings.availability(A, { serviceId: w.service.id, date: TUE }, NOW);
    expect(without.slots.map((s) => local(s.startAt))).toEqual(["09:00", "11:00"]);
    const own = await w.bookings.availability(A, { serviceId: w.service.id, date: TUE, excludeAppointmentId: "mine" }, NOW);
    expect(own.slots.map((s) => local(s.startAt))).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30", "10:45", "11:00"]);
  });

  it("a foreign or unknown excludeAppointmentId is 404", async () => {
    const w = await world();
    w.prisma.db.appointment.push(booking({ id: "theirs", workspaceId: B, contactId: "cB", startAt: new Date("2026-11-17T07:00:00Z") }));
    for (const id of ["theirs", "nope"]) {
      expect(await failure(w.bookings.availability(A, { serviceId: w.service.id, date: TUE, excludeAppointmentId: id }, NOW))).toEqual({
        status: 404,
        body: expect.objectContaining({ message: "Appointment not found" }),
      });
    }
  });

  it("durationMin overrides the service duration (validated 5..1440) and is echoed", async () => {
    const w = await world();
    const out = await w.bookings.availability(A, { serviceId: w.service.id, date: TUE, durationMin: 150 }, NOW);
    expect(out.durationMin).toBe(150);
    expect(out.slots.map((s) => local(s.startAt))).toEqual(["09:00", "09:15", "09:30"]); // must end by 12:00
    for (const d of [4, 1441, 2.5]) {
      expect((await failure(w.bookings.availability(A, { serviceId: w.service.id, date: TUE, durationMin: d }, NOW))).body).toMatchObject({
        message: "bookings.duration_invalid",
        min: 5,
        max: 1440,
      });
    }
  });
});
