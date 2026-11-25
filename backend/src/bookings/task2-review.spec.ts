/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SP-10 Task 2 review findings (C1, C2, I1, I2, I3, M3), turned from the
 * reviewer's probes into specs. Each failed before its fix.
 */
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { McpToolsFactory } from "../mcp-server/mcp-tools.factory";
import { CreateAppointmentDto, UpdateAppointmentDto } from "../appointments/appointments.dto";
import { BookingsService } from "./bookings.service";
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
const open = (w: any) => w.prisma.db.appointment.filter((a: any) => ["pending", "confirmed"].includes(a.status));

describe("C1: unlinking the resource never writes an ungated row", () => {
  it("unlinking the resource while moving onto a taken slot gets SLOT_TAKEN (R4 resolves the member's resource)", async () => {
    const w = await bookingWorld({ locks: true });
    const a = await w.appointments.create(A, catalog(w, 10) as any);
    const b = await w.appointments.create(A, catalog(w, 13, 0, { contactId: "c2" }) as any);
    const r = await failure(w.appointments.update(A, b.id, { resourceId: null, startAt: riyadh(10).toISOString() }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ message: "SLOT_TAKEN", conflict: { id: a.id } });
    expect(w.prisma.db.appointment.find((x: any) => x.id === b.id).startAt).toEqual(riyadh(13));
    // Outside hours is gated too.
    expect((await failure(w.appointments.update(A, b.id, { resourceId: null, startAt: riyadh(6).toISOString() }))).status).toBe(422);
    // A free time works; the row stays on the member's resource (R4), so it keeps blocking honestly.
    const moved = await w.appointments.update(A, b.id, { resourceId: null, startAt: riyadh(15).toISOString() });
    expect(moved).toMatchObject({ resourceId: w.resource.id, staffId: "uAgent", conflict: false });
  });

  it('"" for resourceId or serviceId is refused by the DTO, the MCP schemas and the writer (never a FK 500)', async () => {
    for (const body of [{ resourceId: "" }, { serviceId: "" }]) {
      expect((await validate(plainToInstance(UpdateAppointmentDto, body))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(CreateAppointmentDto, { ...legacyInput(), ...body }))).length).toBeGreaterThan(0);
    }
    expect(await validate(plainToInstance(UpdateAppointmentDto, { resourceId: null }))).toEqual([]);
    const w = await bookingWorld({ locks: true });
    const b = await w.appointments.create(A, catalog(w, 13) as any);
    expect((await failure(w.appointments.update(A, b.id, { resourceId: "", startAt: riyadh(10).toISOString() }))).body.message).toBe(
      "bookings.resource_not_found",
    );
    expect((await failure(w.appointments.update(A, b.id, { serviceId: "" }))).body.message).toBe("bookings.service_not_found");
    expect((await failure(w.appointments.create(A, { ...catalog(w, 15), resourceId: "" } as any))).body.message).toBe(
      "bookings.resource_not_found",
    );
    const tools = new McpToolsFactory(w.appointments, {} as never, {} as never, w.bookings).build(A);
    const upd = (tools.update_appointment as any).inputSchema;
    const crt = (tools.create_appointment as any).inputSchema;
    expect(upd.safeParse({ id: b.id, resourceId: "" }).success).toBe(false);
    expect(upd.safeParse({ id: b.id, serviceId: "" }).success).toBe(false);
    expect(crt.safeParse({ ...legacyInput(), serviceId: "" }).success).toBe(false);
  });
});

describe("C2: update decides on a fresh read under the lock", () => {
  it("cancel → rebook → late confirm (stale read) ends with exactly one confirmed booking", async () => {
    const w = await bookingWorld({ locks: true });
    const x = await w.appointments.create(A, catalog(w, 10, 0, { status: "pending" }) as any);
    const orig = w.prisma.appointment.findFirst;
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    let first = true;
    w.prisma.appointment.findFirst = jest.fn(async (args: any) => {
      const row = await orig(args);
      if (first && args?.where?.id === x.id) {
        first = false;
        await paused; // the agent's confirm read X as pending, then stalls
      }
      return row;
    });
    const confirm = w.appointments.update(A, x.id, { status: "confirmed" });
    await new Promise((r) => setTimeout(r, 5));
    await w.appointments.update(A, x.id, { status: "cancelled" });
    const y = await w.appointments.create(A, catalog(w, 10, 0, { contactId: "c2" }) as any);
    release();
    const res = await failure(confirm);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ message: "bookings.illegal_transition", from: "cancelled", to: "confirmed" });
    expect(open(w).map((a: any) => a.id)).toEqual([y.id]);
    expect(w.prisma.db.appointment.find((a: any) => a.id === x.id).status).toBe("cancelled");
  });

  it("two concurrent moves of one booking never merge into an unchecked span", async () => {
    const w = await bookingWorld({ locks: true });
    const other = await w.appointments.create(A, catalog(w, 12, 0, { contactId: "c2" }) as any);
    const x = await w.appointments.create(A, catalog(w, 9) as any);
    // W1 moves X to 11:00 (ends 12:00); W2 extends X to 150 min from a stale 09:00 read.
    const orig = w.prisma.appointment.findFirst;
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    let calls = 0;
    w.prisma.appointment.findFirst = jest.fn(async (args: any) => {
      const row = await orig(args);
      if (args?.where?.id === x.id && ++calls === 1) await paused;
      return row;
    });
    const w2 = w.appointments.update(A, x.id, { durationMin: 150 });
    await new Promise((r) => setTimeout(r, 5));
    await w.appointments.update(A, x.id, { startAt: riyadh(11).toISOString() });
    release();
    const r2 = await w2.then(
      (v: any) => ({ ok: v }),
      (e: any) => ({ err: e.getResponse() }),
    );
    // 11:00 + 150 min overlaps the 12:00 booking: refused on the fresh data.
    expect(r2).toMatchObject({ err: { message: "SLOT_TAKEN", conflict: { id: other.id } } });
    const row = w.prisma.db.appointment.find((a: any) => a.id === x.id);
    expect([row.startAt.toISOString(), row.durationMin]).toEqual([riyadh(11).toISOString(), 60]);
  });

  it("a write that loses its decision to a writer that takes no lock (main) is retried on fresh data", async () => {
    const w = await bookingWorld({ locks: true });
    const x = await w.appointments.create(A, catalog(w, 10, 0, { status: "pending" }) as any);
    const origUpdateMany = w.prisma.appointment.updateMany;
    let once = true;
    w.prisma.appointment.updateMany = jest.fn((args: any) => {
      if (once && args?.where?.id === x.id) {
        once = false;
        // `main` completes the booking between our read and our write (no version bump).
        const row = w.prisma.db.appointment.find((a: any) => a.id === x.id);
        row.status = "cancelled";
      }
      return origUpdateMany(args);
    });
    const r = await failure(w.appointments.update(A, x.id, { status: "confirmed" }));
    expect(r.body).toMatchObject({ message: "bookings.illegal_transition", from: "cancelled" });
  });
});

describe("I1: the no-parameter list annotation is not quadratic", () => {
  it("annotates 20 000 rows of 5 members quickly, with the same flags as the pairwise rule", async () => {
    const prisma: any = {
      workspace: { findUnique: async () => ({ timezone: "Asia/Riyadh" }) },
      staffResource: { findMany: async () => [1, 2, 3, 4, 5].map((i) => ({ id: "r" + i, userId: "u" + i, schedule: {} })) },
    };
    const rows: any[] = Array.from({ length: 20_000 }, (_, i) => ({
      id: "a" + i,
      startAt: new Date(Date.UTC(2024, 0, 1) + i * 3 * 3600e3),
      durationMin: i % 97 === 0 ? 1200 : 60, // some long ones overlap the next row of their bucket (15 h later)
      status: i % 13 === 0 ? "cancelled" : "confirmed",
      resourceId: i % 3 === 0 ? "r" + ((i % 5) + 1) : null,
      staffId: "u" + ((i % 5) + 1),
    }));
    const t = Date.now();
    const out = await new BookingsService(prisma).annotate("ws", rows, { complete: true });
    expect(Date.now() - t).toBeLessThan(3000);
    // Same answers as the O(n²) definition on a sample.
    const key = (a: any) => ({ r: a.resourceId ?? "r" + a.staffId.slice(1), m: a.staffId });
    const ov = (a: any, b: any) => a.startAt.getTime() < b.startAt.getTime() + b.durationMin * 6e4 && a.startAt.getTime() + a.durationMin * 6e4 > b.startAt.getTime();
    const openRows = rows.filter((r) => r.status === "confirmed");
    for (let i = 0; i < 20_000; i += 487) {
      const r = rows[i];
      const want =
        r.status === "confirmed" &&
        openRows.some((c) => c.id !== r.id && (key(c).r === key(r).r || key(c).m === key(r).m) && ov(r, c));
      expect({ i, conflict: out[i].conflict }).toEqual({ i, conflict: want });
    }
    expect(out.some((r) => r.conflict)).toBe(true);
  });
});

describe("I2: availability does not silently truncate", () => {
  it("5 staff 09:00–21:00, 15-min service: every slot through 20:45 is returned, truncated: false; find_slots too", async () => {
    const w = await bookingWorld();
    const svc = await w.services.create(A, { name: "Quick", nameAr: "سريع", durationMin: 15 });
    const day = { from: "09:00", to: "21:00" };
    const sched = { sun: [day], mon: [day], tue: [day], wed: [day], thu: [day] };
    for (let i = 0; i < 5; i++) await w.staff.create(A, { name: "S" + i, schedule: sched, serviceIds: [svc.id] });
    const avail = await w.bookings.availability(A, { serviceId: svc.id, date: "2027-01-05" }, new Date("2027-01-04T00:00:00Z"));
    expect(avail.slots).toHaveLength(5 * 48);
    expect(avail.slots.at(-1)?.startAt).toBe("2027-01-05T20:45:00+03:00");
    expect((avail as any).truncated).toBe(false);
    const tools = new McpToolsFactory(w.appointments, {} as never, {} as never, w.bookings).build(A);
    // find_slots is the same call (its own date bound is relative to now): same shape, with truncated.
    const spy = jest.spyOn(w.bookings, "availability");
    await tools.find_slots.execute!({ serviceId: svc.id, date: "2027-01-05" } as never, {} as never).catch(() => undefined);
    expect(spy).toHaveBeenCalledWith(A, { serviceId: svc.id, date: "2027-01-05" });
  });
});

describe("R-M2: find_slots gives the agent one entry per start time", () => {
  it("5 staff 09:00–21:00, 15-min service: 48 entries {startAt, resourceIds[5]}, far smaller than the REST list, which is unchanged", async () => {
    const w = await bookingWorld();
    const svc = await w.services.create(A, { name: "Quick", nameAr: "سريع", durationMin: 15 });
    const day = { from: "09:00", to: "21:00" };
    const sched = { sun: [day], mon: [day], tue: [day], wed: [day], thu: [day] };
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await w.staff.create(A, { name: "S" + i, schedule: sched, serviceIds: [svc.id] })).id);
    const now = new Date("2027-01-04T00:00:00Z");
    const orig = w.bookings.availability.bind(w.bookings);
    jest.spyOn(w.bookings, "availability").mockImplementation((ws, q) => orig(ws, q, now));
    const rest = await orig(A, { serviceId: svc.id, date: "2027-01-05" }, now);
    expect(rest.slots).toHaveLength(5 * 48);
    expect(rest.slots[0]).toEqual({ startAt: "2027-01-05T09:00:00+03:00", resourceId: expect.any(String) });

    const tools = new McpToolsFactory(w.appointments, {} as never, {} as never, w.bookings).build(A);
    const out: any = await tools.find_slots.execute!({ serviceId: svc.id, date: "2027-01-05" } as never, {} as never);
    expect(out).toMatchObject({ date: "2027-01-05", serviceId: svc.id, durationMin: 15, unconfigured: [], truncated: false });
    expect(out.slots).toHaveLength(48);
    expect(out.slots[0]).toEqual({ startAt: "2027-01-05T09:00:00+03:00", resourceIds: expect.any(Array) });
    expect(out.slots.at(-1).startAt).toBe("2027-01-05T20:45:00+03:00");
    for (const s of out.slots) {
      expect(Object.keys(s).sort()).toEqual(["resourceIds", "startAt"]);
      expect([...s.resourceIds].sort()).toEqual([...ids].sort());
    }
    // Every (start, resource) pair of the REST list is still there.
    const pairs = out.slots.flatMap((s: any) => s.resourceIds.map((r: string) => `${s.startAt}|${r}`)).sort();
    expect(pairs).toEqual(rest.slots.map((s) => `${s.startAt}|${s.resourceId}`).sort());
    const size = JSON.stringify(out).length;
    expect(size).toBeLessThan(JSON.stringify(rest).length / 2);
    expect(size).toBeLessThan(12_000);
  });
});

describe("I3: duration cap and the overlap look-back", () => {
  it("the writer refuses durationMin outside 1..1440 for every caller; the MCP schemas cap it", async () => {
    const w = await bookingWorld();
    for (const durationMin of [0, 1441, 3000, 1.5]) {
      expect({ durationMin, r: (await failure(w.appointments.create(A, legacyInput({ durationMin })))).body }).toMatchObject({
        durationMin,
        r: { message: "bookings.duration_invalid", min: 1, max: 1440 },
      });
    }
    const row = await w.appointments.create(A, legacyInput());
    expect((await failure(w.appointments.update(A, row.id, { durationMin: 2000 }))).body.message).toBe("bookings.duration_invalid");
    const tools = new McpToolsFactory(w.appointments, {} as never, {} as never, w.bookings).build(A);
    expect((tools.create_appointment as any).inputSchema.safeParse(legacyInput({ durationMin: 1441 })).success).toBe(false);
    expect((tools.update_appointment as any).inputSchema.safeParse({ id: "x", durationMin: 1441 }).success).toBe(false);
  });

  it("a pre-existing 3000-minute booking (written by main) still blocks a booking 30 h later", async () => {
    const w = await bookingWorld({ locks: true });
    const room = await w.staff.create(A, { name: "Room", serviceIds: [w.service.id] }); // unconfigured: fit not gated
    w.prisma.db.appointment.push(booking({ id: "long", contactId: "c2", resourceId: room.id, status: "confirmed", startAt: riyadh(10), durationMin: 3000 }));
    const later = new Date(riyadh(10).getTime() + 30 * 3600e3);
    expect((await failure(w.appointments.create(A, legacyInput({ resourceId: room.id, startAt: later.toISOString() })))).body).toMatchObject({
      message: "SLOT_TAKEN",
      conflict: { id: "long" },
    });
    // The flag on a filtered list sees it too.
    w.prisma.db.appointment.push(booking({ id: "bypassed", contactId: "c1", resourceId: room.id, status: "confirmed", startAt: later }));
    const listed = await w.appointments.list(A, { resourceId: room.id, from: new Date(later.getTime() - 3600e3).toISOString(), to: new Date(later.getTime() + 3600e3).toISOString() });
    expect(listed.find((r: any) => r.id === "bypassed")).toMatchObject({ conflict: true });
  });
});

describe("M3: search scans the bookings nearest the present", () => {
  it("with many future bookings, a past booking is still found", async () => {
    const w = await bookingWorld();
    const now = Date.now();
    for (let i = 0; i < 2500; i++) w.prisma.db.appointment.push(booking({ contactId: "c2", startAt: new Date(now + (i + 1) * 3600e3) }));
    w.prisma.db.appointment.push(booking({ id: "past", contactId: "c1", startAt: new Date(now - 86_400_000), service: "Haircut" }));
    const items = (await w.appointments.search(A, "ليلى")).items;
    expect(items.map((i) => i.id)).toEqual(["past"]);
  });
});
