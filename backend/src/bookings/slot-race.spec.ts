/* eslint-disable @typescript-eslint/no-explicit-any */
import { A, booking, bookingWorld, failure, legacyInput, riyadh } from "./booking-test-world";
import { BOOKING_TX_MAX_WAIT_MS, BOOKING_TX_TIMEOUT_MS } from "./booking-constants";
import { isTransactionTimeout } from "./booking-writer";

/**
 * Review Focus 4 over the in-memory double whose advisory lock is a real
 * per-key async mutex (`withAdvisoryLocks`). slot-race.db.spec.ts repeats
 * case 1 on Postgres.
 */
describe("slot-race.spec.ts", () => {
  const catalog = (w: any, h: number, m = 0, over: Record<string, unknown> = {}) => ({
    contactId: "c1",
    serviceId: w.service.id,
    resourceId: w.resource.id,
    startAt: riyadh(h, m).toISOString(),
    status: "confirmed",
    source: "human",
    ...over,
  });

  it("two creates on one slot: one wins, one gets SLOT_TAKEN", async () => {
    const w = await bookingWorld({ locks: true });
    const results = await Promise.allSettled([
      w.controller.create(A, catalog(w, 10) as any),
      w.controller.create(A, catalog(w, 10, 30, { contactId: "c2" }) as any),
    ]);
    const won = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = won[0].value;
    expect(lost[0].reason.getStatus()).toBe(409);
    expect(lost[0].reason.getResponse()).toEqual({
      statusCode: 409,
      message: "SLOT_TAKEN",
      conflict: { id: winner.id, startAt: winner.startAt, durationMin: 60, status: "confirmed" },
    });
    expect(w.prisma.db.appointment.filter((a: any) => a.resourceId === w.resource.id)).toHaveLength(1);
    // Both writers took the resource lock.
    expect(w.locks!.order.filter((k: string) => k.includes(`booking-resource:${w.resource.id}`))).toHaveLength(2);
  });

  it("back-to-back bookings both succeed", async () => {
    const w = await bookingWorld({ locks: true });
    const [a, b] = await Promise.all([
      w.controller.create(A, catalog(w, 10) as any),
      w.controller.create(A, catalog(w, 11, 0, { contactId: "c2" }) as any),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(w.prisma.db.appointment).toHaveLength(2);
  });

  it("reschedule onto a taken slot gets SLOT_TAKEN", async () => {
    const w = await bookingWorld({ locks: true });
    const first = await w.appointments.create(A, catalog(w, 10) as any);
    const second = await w.appointments.create(A, catalog(w, 12, 0, { contactId: "c2" }) as any);
    const r = await failure(w.appointments.update(A, second.id, { startAt: riyadh(10, 30).toISOString() }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ message: "SLOT_TAKEN", conflict: { id: first.id, durationMin: 60, status: "confirmed" } });
    // Moving onto its own time (overlapping only itself) is fine.
    expect(await w.appointments.update(A, second.id, { startAt: riyadh(12, 30).toISOString() })).toMatchObject({ id: second.id });
  });

  it("two concurrent reschedules onto one free slot: one wins", async () => {
    const w = await bookingWorld({ locks: true });
    const a = await w.appointments.create(A, catalog(w, 9) as any);
    const b = await w.appointments.create(A, catalog(w, 12, 0, { contactId: "c2" }) as any);
    const results = await Promise.allSettled([
      w.appointments.update(A, a.id, { startAt: riyadh(14).toISOString() }),
      w.appointments.update(A, b.id, { startAt: riyadh(14, 15).toISOString() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.getResponse().message).toBe("SLOT_TAKEN");
  });

  it("legacy staff booking blocks the member's resource (in availability and in create)", async () => {
    const w = await bookingWorld({ locks: true });
    // A free-text booking (no resourceId) of member uAgent, as the agent or main would write.
    w.prisma.db.appointment.push(
      booking({ id: "legacy", contactId: "c2", staffId: "uAgent", resourceId: null, serviceId: null, status: "pending", startAt: riyadh(10) }),
    );
    const avail = await w.bookings.availability(A, { serviceId: w.service.id, date: "2027-01-05" }, new Date("2027-01-04T00:00:00Z"));
    const starts = avail.slots.map((s) => s.startAt.slice(11, 16));
    expect(starts).not.toContain("10:00");
    expect(starts).not.toContain("09:15"); // 09:15-10:15 overlaps 10:00
    expect(starts).toContain("09:00");
    expect(starts).toContain("11:00");
    // A catalog create on the resource is refused…
    expect((await failure(w.appointments.create(A, catalog(w, 10, 30) as any))).body).toMatchObject({
      message: "SLOT_TAKEN",
      conflict: { id: "legacy" },
    });
    // …and so is a legacy create with the member's staffId (ruling 4 resolves the resource).
    expect((await failure(w.appointments.create(A, legacyInput({ staffId: "uAgent", startAt: riyadh(10, 15).toISOString() })))).body).toMatchObject({
      message: "SLOT_TAKEN",
    });
  });

  it("cancelled and no-show bookings do not block", async () => {
    const w = await bookingWorld({ locks: true });
    w.prisma.db.appointment.push(
      booking({ contactId: "c2", resourceId: w.resource.id, status: "cancelled", startAt: riyadh(10) }),
      booking({ contactId: "c2", staffId: "uAgent", status: "no-show", startAt: riyadh(10) }),
      booking({ contactId: "c2", resourceId: w.resource.id, status: "completed", startAt: riyadh(10) }),
    );
    expect(await w.appointments.create(A, catalog(w, 10) as any)).toMatchObject({ resourceId: w.resource.id, conflict: false });
  });

  it("a member without a resource keeps the old behaviour: no gate, overlaps allowed", async () => {
    const w = await bookingWorld({ locks: true });
    const a = await w.appointments.create(A, legacyInput({ staffId: "uOwner" }));
    const b = await w.appointments.create(A, legacyInput({ staffId: "uOwner", contactId: "c2" }));
    expect(a.resourceId).toBeNull();
    expect(b.resourceId).toBeNull();
    // The overlap is shown, not hidden.
    expect(b.conflict).toBe(true);
    expect(b.fit).toBe("unchecked");
  });
});

describe("booking writer transaction budget (SP-10 live fix F1)", () => {
  const at = (w: any, h: number, m = 0, contactId = "c1") => ({
    contactId,
    serviceId: w.service.id,
    resourceId: w.resource.id,
    startAt: riyadh(h, m).toISOString(),
    status: "confirmed",
    source: "human",
  });

  it("the writer's transaction passes the named timeout and maxWait", async () => {
    expect(BOOKING_TX_TIMEOUT_MS).toBe(20_000);
    expect(BOOKING_TX_MAX_WAIT_MS).toBe(10_000);
    const w = await bookingWorld({ locks: true });
    w.prisma.$transaction.mockClear();
    w.prisma.$executeRaw.mockClear?.();
    await w.controller.create(A, at(w, 10) as any);
    // The writer's transaction (the one that takes the advisory locks) carries the budget.
    const budgeted = w.prisma.$transaction.mock.calls.filter((c: any[]) => typeof c[0] === "function" && c[1] !== undefined);
    expect(budgeted).toHaveLength(1);
    expect(budgeted[0][1]).toEqual({ timeout: BOOKING_TX_TIMEOUT_MS, maxWait: BOOKING_TX_MAX_WAIT_MS });
    expect(w.locks!.order.some((k: string) => k.includes(`booking-resource:${w.resource.id}`))).toBe(true);
  });

  it("a P2028 transaction timeout is a keyed 409 bookings.busy, never a 500, and writes nothing", async () => {
    const w = await bookingWorld({ locks: true });
    const p2028 = Object.assign(
      new Error("Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms"),
      { code: "P2028" },
    );
    w.prisma.$transaction.mockImplementationOnce(async () => {
      throw p2028;
    });
    const r = await failure(w.controller.create(A, at(w, 10) as any));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ statusCode: 409, message: "bookings.busy" });
    expect(w.prisma.db.appointment.filter((a: any) => a.resourceId === w.resource.id)).toHaveLength(0);
    // The next attempt goes through.
    expect(await w.controller.create(A, at(w, 10) as any)).toMatchObject({ resourceId: w.resource.id });
  });

  it("only transaction timeouts are renamed", () => {
    expect(isTransactionTimeout({ code: "P2028", message: "x" })).toBe(true);
    expect(isTransactionTimeout(new Error("Transaction API error: Unable to start a transaction in the given time."))).toBe(true);
    expect(isTransactionTimeout(new Error("Transaction already closed: the timeout for this transaction was 5000 ms"))).toBe(true);
    expect(isTransactionTimeout({ code: "P2002", message: "Unique constraint failed" })).toBe(false);
    expect(isTransactionTimeout(new Error("boom"))).toBe(false);
    expect(isTransactionTimeout(null)).toBe(false);
  });

  it("ten parallel creates on one slot: one wins, nine get SLOT_TAKEN", async () => {
    const w = await bookingWorld({ locks: true });
    w.prisma.db.contact.push(
      ...Array.from({ length: 8 }, (_, i) => ({ id: `cx${i}`, workspaceId: A, name: `C${i}`, phone: `+96650000010${i}`, hjzClientId: null })),
    );
    const ids = ["c1", "c2", ...Array.from({ length: 8 }, (_, i) => `cx${i}`)];
    const results = await Promise.allSettled(ids.map((c) => w.controller.create(A, at(w, 10, 0, c) as any)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(lost).toHaveLength(9);
    for (const l of lost) expect(l.reason.getResponse().message).toBe("SLOT_TAKEN");
    expect(w.prisma.db.appointment.filter((a: any) => a.resourceId === w.resource.id)).toHaveLength(1);
  });
});
