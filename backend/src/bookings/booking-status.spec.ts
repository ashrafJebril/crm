/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpToolsFactory } from "../mcp-server/mcp-tools.factory";
import { APPOINTMENT_STATUSES, BOOKING_ALLOWED, assertTransition } from "./booking-status";
import { A, booking, bookingWorld, failure, legacyInput, riyadh } from "./booking-test-world";

function errOf(fn: () => unknown) {
  try {
    fn();
  } catch (e: any) {
    return { status: e.getStatus(), body: e.getResponse() };
  }
  return null;
}

describe("illegal transition completed→pending rejected", () => {
  it("the pure table: completed → pending is 409 bookings.illegal_transition {from, to, allowed: []}", () => {
    expect(errOf(() => assertTransition("completed", "pending"))).toEqual({
      status: 409,
      body: { statusCode: 409, message: "bookings.illegal_transition", from: "completed", to: "pending", allowed: [] },
    });
  });

  it("every allowed pair passes; every other pair is refused; a same-status write is a no-op", () => {
    for (const from of APPOINTMENT_STATUSES) {
      for (const to of APPOINTMENT_STATUSES) {
        if (from === to) {
          expect(assertTransition(from, to)).toBe(false);
        } else if ((BOOKING_ALLOWED[from] as string[]).includes(to)) {
          expect(assertTransition(from, to)).toBe(true);
        } else {
          expect({ from, to, err: errOf(() => assertTransition(from, to))?.body.message }).toEqual({
            from,
            to,
            err: "bookings.illegal_transition",
          });
        }
      }
    }
    expect(BOOKING_ALLOWED).toEqual({
      pending: ["confirmed", "cancelled"],
      confirmed: ["completed", "no-show", "cancelled"],
      completed: [],
      cancelled: [],
      "no-show": [],
    });
  });

  it("through the service and PATCH /appointments/:id", async () => {
    const w = await bookingWorld();
    w.prisma.db.appointment.push(booking({ id: "done", contactId: "c1", status: "completed", startAt: riyadh(10) }));
    const viaService = await failure(w.appointments.update(A, "done", { status: "pending" }));
    const viaPatch = await failure(w.controller.update(A, "done", { status: "pending" }));
    for (const r of [viaService, viaPatch]) {
      expect(r).toEqual({
        status: 409,
        body: { statusCode: 409, message: "bookings.illegal_transition", from: "completed", to: "pending", allowed: [] },
      });
    }
    expect(w.prisma.db.appointment.find((a: any) => a.id === "done").status).toBe("completed");
  });

  it("through the MCP update_appointment tool, and cancel_appointment on a completed booking is a tool error", async () => {
    const w = await bookingWorld();
    w.prisma.db.appointment.push(booking({ id: "done", contactId: "c1", status: "completed", startAt: riyadh(10) }));
    const tools = new McpToolsFactory(w.appointments, {} as never, {} as never, w.bookings).build(A);
    await expect(tools.update_appointment.execute!({ id: "done", status: "pending" } as never, {} as never)).rejects.toThrow(
      'bookings.illegal_transition {"from":"completed","to":"pending","allowed":[]}',
    );
    await expect(tools.cancel_appointment.execute!({ id: "done" } as never, {} as never)).rejects.toThrow(
      "bookings.illegal_transition",
    );
  });

  it("every allowed pair succeeds through the service; a same-status write is a no-op that still saves other fields", async () => {
    const w = await bookingWorld();
    const paths: [string, string][] = [
      ["pending", "confirmed"],
      ["pending", "cancelled"],
      ["confirmed", "completed"],
      ["confirmed", "no-show"],
      ["confirmed", "cancelled"],
    ];
    let h = 9;
    for (const [from, to] of paths) {
      const row = await w.appointments.create(A, legacyInput({ status: from, startAt: riyadh(h++).toISOString(), staffId: "uAgent" }));
      expect((await w.appointments.update(A, row.id, { status: to as any })).status).toBe(to);
    }
    const p = await w.appointments.create(A, legacyInput({ status: "pending", startAt: riyadh(15).toISOString() }));
    const same = await w.appointments.update(A, p.id, { status: "pending", note: "same" });
    expect(same).toMatchObject({ status: "pending", note: "same" });
  });

  it("a time, duration or resource change on a final booking is 409 bookings.closed", async () => {
    const w = await bookingWorld();
    w.prisma.db.appointment.push(booking({ id: "gone", contactId: "c1", status: "cancelled", startAt: riyadh(10) }));
    for (const patch of [
      { startAt: riyadh(11).toISOString() },
      { durationMin: 30 },
      { resourceId: w.resource.id },
      { staffId: "uOwner" },
    ]) {
      expect(await failure(w.appointments.update(A, "gone", patch as any))).toEqual({
        status: 409,
        body: { statusCode: 409, message: "bookings.closed", status: "cancelled" },
      });
    }
    // A note on a final booking is fine.
    expect(await w.appointments.update(A, "gone", { note: "late" })).toMatchObject({ note: "late", status: "cancelled" });
  });
});
