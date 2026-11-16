/* eslint-disable @typescript-eslint/no-explicit-any */
import { ServicesController } from "../services/services.controller";
import { StaffController } from "../staff/staff.controller";
import { routesOf } from "../permissions/permission-map";
import { A, B, booking, catalogWorld, failure } from "./catalog-test-world";

/** A plausible body per handler, so only the id decides the outcome. */
const BODIES: Record<string, unknown> = {
  update: { name: "Renamed" },
  setStaff: { staffIds: [] },
  setServices: { serviceIds: [] },
};

describe("foreign ids return 404 on SP-10 catalog routes", () => {
  async function setup() {
    const w = catalogWorld();
    const svcA = await w.services.create(A, { name: "Cut A", durationMin: 30 });
    const svcB = await w.services.create(B, { name: "Cut B", durationMin: 30 });
    const resA = await w.staff.create(A, { name: "Sara A" });
    const resB = await w.staff.create(B, { name: "Sara B" });
    w.prisma.db.appointment.push(booking({ workspaceId: B, serviceId: svcB.id, resourceId: resB.id }));
    return {
      ...w,
      svcA,
      svcB,
      resA,
      resB,
      services: new ServicesController(w.services),
      staff: new StaffController(w.staff),
    };
  }

  for (const [label, Ctrl, ownKey, otherKey, notFound] of [
    ["services", ServicesController, "svcA", "svcB", "bookings.service_not_found"],
    ["staff", StaffController, "resA", "resB", "bookings.resource_not_found"],
  ] as const) {
    const idRoutes = routesOf(Ctrl).filter((r) => r.key.includes(":id"));

    it(`${label}: every :id route is covered (${idRoutes.length})`, () => {
      expect(idRoutes.map((r) => r.key).sort()).toEqual(
        label === "services"
          ? [
              "DELETE /services/:id",
              "GET /services/:id/delete-preview",
              "PATCH /services/:id",
              "POST /services/:id/restore",
              "PUT /services/:id/staff",
            ]
          : ["DELETE /staff/:id", "GET /staff/:id/delete-preview", "PATCH /staff/:id", "POST /staff/:id/restore", "PUT /staff/:id/services"],
      );
    });

    it.each(idRoutes.map((r) => [r.key, r.handler.name] as const))(
      `${label}: %s with workspace B's id from A → 404, B's row untouched`,
      async (_key, method) => {
        const w = await setup();
        const ctrl = label === "services" ? w.services : w.staff;
        const other = (w as any)[otherKey];
        const before = JSON.stringify(label === "services" ? w.prisma.db.service : w.prisma.db.staffResource);
        const args = BODIES[method] === undefined ? [A, other.id] : [A, other.id, BODIES[method]];
        const res = await failure((ctrl as any)[method](...args));
        expect(res).toEqual({ status: 404, body: { statusCode: 404, message: notFound } });
        expect(JSON.stringify(label === "services" ? w.prisma.db.service : w.prisma.db.staffResource)).toBe(before);
        // The same route with A's own id succeeds.
        const own = (w as any)[ownKey];
        const okArgs = BODIES[method] === undefined ? [A, own.id] : [A, own.id, BODIES[method]];
        await expect((ctrl as any)[method](...okArgs)).resolves.toBeDefined();
      },
    );
  }

  it("lists never show another workspace's rows", async () => {
    const w = await setup();
    expect((await w.services.list(A, {})).items.map((s: any) => s.id)).toEqual([w.svcA.id]);
    expect((await w.staff.list(A, {})).items.map((s: any) => s.id)).toEqual([w.resA.id]);
  });

  it("cross links: B's staff on A's service and B's service on A's staff are 404", async () => {
    const w = await setup();
    expect((await failure(w.services.setStaff(A, w.svcA.id, { staffIds: [w.resB.id] }))).body.message).toBe(
      "bookings.resource_not_found",
    );
    expect((await failure(w.staff.setServices(A, w.resA.id, { serviceIds: [w.svcB.id] }))).body.message).toBe(
      "bookings.service_not_found",
    );
  });
});
