/* eslint-disable @typescript-eslint/no-explicit-any */
import { A, booking, catalogWorld, failure } from "../bookings/catalog-test-world";
import { bookingError } from "../bookings/booking-errors";
import { lockService, serviceLockKey } from "../bookings/booking-locks";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The booking writer's contract with the archive (Task 2's booking-writer.ts
 * follows it): inside its transaction it takes the service lock, re-reads the
 * service, refuses an archived one, then inserts. `holdMs` keeps the lock
 * between the read and the insert, to force an interleaving.
 */
function bookAgainstService(prisma: any, serviceId: string, holdMs = 0) {
  return prisma.$transaction(async (tx: any) => {
    await lockService(tx, serviceId);
    const svc = await tx.service.findFirst({ where: { id: serviceId, workspaceId: A } });
    if (!svc) throw bookingError("bookings.service_not_found");
    if (svc.archivedAt || !svc.active) throw bookingError("bookings.service_archived");
    if (holdMs) await sleep(holdMs);
    return tx.appointment.create({
      data: booking({ serviceId, service: svc.name, serviceAr: svc.nameAr, durationMin: svc.durationMin }),
    });
  });
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error("condition never held");
}

describe("delete-service-with-references archives instead", () => {
  it("a service with one past completed booking is archived, not deleted; the booking keeps its link and names", async () => {
    const { services, staff, prisma } = catalogWorld();
    const s = await services.create(A, { name: "Haircut", nameAr: "قص شعر", durationMin: 30 });
    const r = await staff.create(A, { name: "Sara", serviceIds: [s.id] });
    const past = booking({
      serviceId: s.id,
      resourceId: r.id,
      status: "completed",
      startAt: new Date(Date.now() - 7 * 86_400_000),
    });
    prisma.db.appointment.push(past);

    expect(await services.deletePreview(A, s.id)).toEqual({ bookingCount: 1, upcomingCount: 0, staffCount: 1 });
    expect(await services.remove(A, s.id)).toEqual({ archived: true, bookingCount: 1 });

    const row = prisma.db.service.find((x: any) => x.id === s.id);
    expect(row).toBeDefined();
    expect(row.active).toBe(false);
    expect(row.archivedAt).toBeInstanceOf(Date);
    // The booking keeps serviceId and its name snapshot; staff links are kept.
    const appt = prisma.db.appointment.find((x: any) => x.id === past.id);
    expect(appt).toMatchObject({ serviceId: s.id, service: "Haircut", serviceAr: "قص شعر" });
    expect((await services.get(A, s.id)).staffIds).toEqual([r.id]);
    // Listed as inactive, not active.
    expect((await services.list(A, { active: true })).items.map((x) => x.id)).not.toContain(s.id);
    expect((await services.list(A, { active: false })).items.map((x) => x.id)).toContain(s.id);
    // A second DELETE keeps it archived (same archivedAt).
    const at = row.archivedAt;
    expect(await services.remove(A, s.id)).toEqual({ archived: true, bookingCount: 1 });
    expect(prisma.db.service.find((x: any) => x.id === s.id).archivedAt).toBe(at);
  });

  it("the preview counts every status, upcoming pending/confirmed, and staff links", async () => {
    const { services, staff, prisma } = catalogWorld();
    const s = await services.create(A, { name: "Haircut", durationMin: 30 });
    await staff.create(A, { name: "Sara", serviceIds: [s.id] });
    await staff.create(A, { name: "Lina", serviceIds: [s.id] });
    prisma.db.appointment.push(
      booking({ serviceId: s.id, status: "confirmed" }),
      booking({ serviceId: s.id, status: "pending" }),
      booking({ serviceId: s.id, status: "cancelled" }),
      booking({ serviceId: s.id, status: "no-show", startAt: new Date(Date.now() - 3_600_000) }),
      booking({ serviceId: null, service: "Haircut" }), // free text, same name: not a reference
    );
    expect(await services.deletePreview(A, s.id)).toEqual({ bookingCount: 4, upcomingCount: 2, staffCount: 2 });
  });

  it("a service with no bookings is deleted and its links cascade", async () => {
    const { services, staff, prisma } = catalogWorld();
    const s = await services.create(A, { name: "Haircut", durationMin: 30 });
    const r = await staff.create(A, { name: "Sara", serviceIds: [s.id] });
    prisma.db.appointment.push(booking({ serviceId: null, service: "Haircut" }));
    expect(await services.deletePreview(A, s.id)).toEqual({ bookingCount: 0, upcomingCount: 0, staffCount: 1 });
    expect(await services.remove(A, s.id)).toEqual({ deleted: true });
    expect(prisma.db.service.find((x: any) => x.id === s.id)).toBeUndefined();
    expect(prisma.db.staffService.filter((l: any) => l.serviceId === s.id)).toEqual([]);
    expect((await staff.get(A, r.id)).serviceIds).toEqual([]);
    expect((await failure(services.get(A, s.id))).status).toBe(404);
  });

  it("restore reactivates an archived service", async () => {
    const { services, prisma } = catalogWorld();
    const s = await services.create(A, { name: "Haircut", durationMin: 30 });
    prisma.db.appointment.push(booking({ serviceId: s.id, status: "completed" }));
    await services.remove(A, s.id);
    const restored = await services.restore(A, s.id);
    expect(restored).toMatchObject({ active: true, archivedAt: null });
    expect(restored.version).toBeGreaterThan(0);
    expect((await services.list(A, { active: true })).items.map((x) => x.id)).toContain(s.id);
  });

  it("archived services refuse new bookings through the writer contract", async () => {
    const { services, prisma } = catalogWorld({ locks: true });
    const s = await services.create(A, { name: "Haircut", durationMin: 30 });
    prisma.db.appointment.push(booking({ serviceId: s.id, status: "completed" }));
    await services.remove(A, s.id);
    expect((await failure(bookAgainstService(prisma, s.id))).body.message).toBe("bookings.service_archived");
  });

  describe("a concurrent create against the service is either counted (archive) or refused service_archived", () => {
    it("create holds the lock first → the delete waits and counts it", async () => {
      const { services, prisma, locks } = catalogWorld({ locks: true });
      const s = await services.create(A, { name: "Haircut", durationMin: 30 });
      prisma.db.appointment.push(booking({ serviceId: s.id, status: "completed" }));
      const key = serviceLockKey(s.id);

      const create = bookAgainstService(prisma, s.id, 20);
      await until(() => locks!.held().some((k) => k.includes(key)));
      const del = services.remove(A, s.id);
      const [created, deleted] = await Promise.all([create, del]);

      expect(created.serviceId).toBe(s.id);
      expect(deleted).toEqual({ archived: true, bookingCount: 2 });
      expect(locks!.order.filter((k) => k.includes(key))).toHaveLength(2);
    });

    it("delete holds the lock first → the create waits and is refused service_archived", async () => {
      const { services, prisma, locks } = catalogWorld({ locks: true });
      const s = await services.create(A, { name: "Haircut", durationMin: 30 });
      prisma.db.appointment.push(booking({ serviceId: s.id, status: "completed" }));
      const key = serviceLockKey(s.id);
      // Keep the delete inside its locked section for a while.
      const count = prisma.appointment.count.getMockImplementation();
      prisma.appointment.count.mockImplementation((a: any) => sleep(20).then(() => count(a)));

      const del = services.remove(A, s.id);
      await until(() => locks!.held().some((k) => k.includes(key)));
      const create = bookAgainstService(prisma, s.id);
      const [deleted, refused] = await Promise.all([del, failure(create)]);

      expect(deleted).toEqual({ archived: true, bookingCount: 1 });
      expect(refused).toEqual({ status: 400, body: { statusCode: 400, message: "bookings.service_archived" } });
      expect(prisma.db.appointment.filter((x: any) => x.serviceId === s.id)).toHaveLength(1);
    });

    it("the delete takes pg_advisory_xact_lock on booking-service:<id> inside its transaction", async () => {
      const { services, prisma } = catalogWorld({ locks: true });
      const s = await services.create(A, { name: "Haircut", durationMin: 30 });
      await services.remove(A, s.id);
      const calls = prisma.$executeRaw.mock.calls.map((c: any[]) => [c[0].join("?"), ...c.slice(1)]);
      expect(calls).toContainEqual(["SELECT pg_advisory_xact_lock(hashtext(?))", `booking-service:${s.id}`]);
    });
  });
});
