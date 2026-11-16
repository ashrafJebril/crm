/* eslint-disable @typescript-eslint/no-explicit-any */
import { A, booking, catalogWorld, failure } from "../bookings/catalog-test-world";
import { bookingError } from "../bookings/booking-errors";
import { lockResource, resourceLockKey } from "../bookings/booking-locks";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The booking writer's contract with the archive, for a resource (see the services spec). */
function bookOnResource(prisma: any, resourceId: string, holdMs = 0) {
  return prisma.$transaction(async (tx: any) => {
    await lockResource(tx, resourceId);
    const res = await tx.staffResource.findFirst({ where: { id: resourceId, workspaceId: A } });
    if (!res) throw bookingError("bookings.resource_not_found");
    if (res.archivedAt || !res.active) throw bookingError("bookings.resource_archived");
    if (holdMs) await sleep(holdMs);
    return tx.appointment.create({ data: booking({ resourceId, staffId: res.userId }) });
  });
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error("condition never held");
}

describe("delete-staff-with-references archives instead", () => {
  it("a resource with one past completed booking is archived; the booking keeps its link; member and service links kept", async () => {
    const { services, staff, prisma } = catalogWorld();
    const s = await services.create(A, { name: "Haircut", durationMin: 30 });
    const r = await staff.create(A, { name: "Sara", userId: "uAgent", serviceIds: [s.id] });
    const past = booking({ resourceId: r.id, staffId: "uAgent", status: "completed", startAt: new Date(Date.now() - 86_400_000) });
    prisma.db.appointment.push(past);

    expect(await staff.deletePreview(A, r.id)).toEqual({ bookingCount: 1, upcomingCount: 0, serviceCount: 1 });
    expect(await staff.remove(A, r.id)).toEqual({ archived: true, bookingCount: 1 });

    const after = await staff.get(A, r.id);
    expect(after).toMatchObject({ active: false, userId: "uAgent", serviceIds: [s.id] });
    expect(after.archivedAt).toBeInstanceOf(Date);
    expect(prisma.db.appointment.find((x: any) => x.id === past.id)).toMatchObject({ resourceId: r.id, staffId: "uAgent" });
    // The member still owns the archived resource: a new one for them is 409 pointing at it.
    expect((await failure(staff.create(A, { name: "Sara 2", userId: "uAgent" }))).body).toMatchObject({
      message: "bookings.member_has_resource",
      resourceId: r.id,
    });
    // PATCH cannot re-activate it; restore does.
    expect((await failure(staff.update(A, r.id, { active: true }))).body.message).toBe("bookings.resource_archived");
    expect(await staff.restore(A, r.id)).toMatchObject({ active: true, archivedAt: null });
  });

  it("the preview counts every status, upcoming pending/confirmed, and service links", async () => {
    const { services, staff, prisma } = catalogWorld();
    const s1 = await services.create(A, { name: "Cut", durationMin: 30 });
    const s2 = await services.create(A, { name: "Colour", durationMin: 30 });
    const r = await staff.create(A, { name: "Sara", serviceIds: [s1.id, s2.id] });
    prisma.db.appointment.push(
      booking({ resourceId: r.id, status: "pending" }),
      booking({ resourceId: r.id, status: "cancelled" }),
      booking({ resourceId: r.id, status: "confirmed", startAt: new Date(Date.now() - 3_600_000) }),
    );
    expect(await staff.deletePreview(A, r.id)).toEqual({ bookingCount: 3, upcomingCount: 1, serviceCount: 2 });
    expect((await staff.get(A, r.id)).upcomingCount).toBe(1);
  });

  it("a resource with no bookings is deleted and its service links cascade", async () => {
    const { services, staff, prisma } = catalogWorld();
    const s = await services.create(A, { name: "Haircut", durationMin: 30 });
    const r = await staff.create(A, { name: "Sara", userId: "uAgent", serviceIds: [s.id] });
    // A legacy booking of the same member (staffId only) is not a reference to the resource.
    prisma.db.appointment.push(booking({ staffId: "uAgent", resourceId: null }));
    expect(await staff.remove(A, r.id)).toEqual({ deleted: true });
    expect(prisma.db.staffResource.find((x: any) => x.id === r.id)).toBeUndefined();
    expect(prisma.db.staffService.filter((l: any) => l.resourceId === r.id)).toEqual([]);
    expect((await services.get(A, s.id)).staffIds).toEqual([]);
    // The member can get a new resource now.
    expect(await staff.create(A, { name: "Sara", userId: "uAgent" })).toMatchObject({ userId: "uAgent" });
  });

  describe("a concurrent booking on the resource is either counted (archive) or refused", () => {
    it("booking holds the lock first → the delete waits and counts it", async () => {
      const { staff, prisma, locks } = catalogWorld({ locks: true });
      const r = await staff.create(A, { name: "Sara" });
      const key = resourceLockKey(r.id);
      const create = bookOnResource(prisma, r.id, 20);
      await until(() => locks!.held().some((k) => k.includes(key)));
      const [created, deleted] = await Promise.all([create, staff.remove(A, r.id)]);
      expect(created.resourceId).toBe(r.id);
      expect(deleted).toEqual({ archived: true, bookingCount: 1 });
    });

    it("delete holds the lock first → the booking waits and is refused", async () => {
      const { staff, prisma, locks } = catalogWorld({ locks: true });
      const r = await staff.create(A, { name: "Sara" });
      prisma.db.appointment.push(booking({ resourceId: r.id, status: "completed" }));
      const key = resourceLockKey(r.id);
      const count = prisma.appointment.count.getMockImplementation();
      prisma.appointment.count.mockImplementation((a: any) => sleep(20).then(() => count(a)));
      const del = staff.remove(A, r.id);
      await until(() => locks!.held().some((k) => k.includes(key)));
      const [deleted, refused] = await Promise.all([del, failure(bookOnResource(prisma, r.id))]);
      expect(deleted).toEqual({ archived: true, bookingCount: 1 });
      expect(refused.body.message).toBe("bookings.resource_archived");
      expect(prisma.db.appointment.filter((x: any) => x.resourceId === r.id)).toHaveLength(1);
    });

    it("delete with no bookings vs a queued booking: the booking finds the resource gone (404)", async () => {
      const { staff, prisma, locks } = catalogWorld({ locks: true });
      const r = await staff.create(A, { name: "Sara" });
      const key = resourceLockKey(r.id);
      const count = prisma.appointment.count.getMockImplementation();
      prisma.appointment.count.mockImplementation((a: any) => sleep(20).then(() => count(a)));
      const del = staff.remove(A, r.id);
      await until(() => locks!.held().some((k) => k.includes(key)));
      const [deleted, refused] = await Promise.all([del, failure(bookOnResource(prisma, r.id))]);
      expect(deleted).toEqual({ deleted: true });
      expect(refused.status).toBe(404);
      expect(prisma.db.appointment).toHaveLength(0);
    });
  });
});
