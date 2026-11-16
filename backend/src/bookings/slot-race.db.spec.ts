/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * slot-race case 1 against real Postgres: two creates on one slot over two
 * connections → exactly one row. Skipped unless BOOKINGS_TEST_DATABASE_URL
 * names a migrated, disposable database (Task 6 runs it). It creates one
 * throwaway workspace (never with externalTenantId, ruling 15) and deletes it.
 */
import { PrismaClient } from "@prisma/client";
import { AppointmentsService } from "../appointments/appointments.service";

const URL = process.env.BOOKINGS_TEST_DATABASE_URL;
const run = URL ? describe : describe.skip;

run("slot-race.db.spec.ts (Postgres)", () => {
  const tag = `slotrace_${Date.now()}`;
  let one: PrismaClient;
  let two: PrismaClient;
  /** When each writer's transaction ran (review I4: prove the two overlapped). */
  const spans: { enter: number; exit: number }[] = [];
  /** Exposes a PrismaClient as the delegates AppointmentsService reads, timing its transactions. */
  const asService = (c: PrismaClient): any =>
    new Proxy(c, {
      get: (t: any, k) => {
        if (k === "raw") return t;
        if (k === "$transaction") {
          return async (fn: any) => {
            const span = { enter: Date.now(), exit: 0 };
            spans.push(span);
            try {
              return await t.$transaction(fn);
            } finally {
              span.exit = Date.now();
            }
          };
        }
        return typeof t[k] === "function" ? t[k].bind(t) : t[k];
      },
    });

  beforeAll(async () => {
    one = new PrismaClient({ datasources: { db: { url: URL } } });
    two = new PrismaClient({ datasources: { db: { url: URL } } });
    await one.workspace.create({ data: { id: tag, name: tag, slug: tag, timezone: "Asia/Riyadh" } });
    await one.contact.create({
      // Every required Contact field (lastSeen has no default; review I4).
      data: { id: `${tag}_c`, workspaceId: tag, name: "Race", industry: "test", lifecycle: "lead", source: "test", lastSeen: "now" },
    });
    await one.service.create({ data: { id: `${tag}_s`, workspaceId: tag, name: "Cut", nameAr: "قص", durationMin: 60 } });
    await one.staffResource.create({
      data: {
        id: `${tag}_r`,
        workspaceId: tag,
        name: "Chair",
        schedule: { mon: [{ from: "00:00", to: "24:00" }], tue: [{ from: "00:00", to: "24:00" }], wed: [{ from: "00:00", to: "24:00" }], thu: [{ from: "00:00", to: "24:00" }], fri: [{ from: "00:00", to: "24:00" }], sat: [{ from: "00:00", to: "24:00" }], sun: [{ from: "00:00", to: "24:00" }] },
      },
    });
    await one.staffService.create({ data: { resourceId: `${tag}_r`, serviceId: `${tag}_s`, workspaceId: tag } });
  });

  afterAll(async () => {
    await one.workspace.delete({ where: { id: tag } }).catch(() => undefined); // cascades every row above
    await Promise.all([one.$disconnect(), two.$disconnect()]);
  });

  it("two creates on one slot: one wins, one gets SLOT_TAKEN", async () => {
    const input = (contactId: string, minute: number): any => ({
      contactId,
      serviceId: `${tag}_s`,
      resourceId: `${tag}_r`,
      startAt: new Date(Date.UTC(2030, 0, 7, 7, minute)).toISOString(),
      status: "confirmed",
      source: "human",
    });
    const results = await Promise.allSettled([
      new AppointmentsService(asService(one)).create(tag, input(`${tag}_c`, 0)),
      new AppointmentsService(asService(two)).create(tag, input(`${tag}_c`, 30)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason.getResponse()).toMatchObject({ statusCode: 409, message: "SLOT_TAKEN" });
    expect(await one.appointment.count({ where: { workspaceId: tag, resourceId: `${tag}_r` } })).toBe(1);
    // Both writers were inside a transaction at the same time (not a serial run).
    expect(spans).toHaveLength(2);
    expect(spans[0].enter).toBeLessThan(spans[1].exit);
    expect(spans[1].enter).toBeLessThan(spans[0].exit);
  });
});
