import { ActivityDueScheduler } from "./activity-due.scheduler";
import { ActivitiesService } from "./activities.service";
import { FakePrisma } from "./activities-test-fakes";

const NOW = new Date("2026-11-10T08:00:00Z");
const HOUR = 3600_000;

function setup() {
  const prisma = new FakePrisma();
  const notifications = { notify: jest.fn().mockResolvedValue(1) };
  const sched = new ActivityDueScheduler(prisma as never, notifications as never);
  return { prisma, notifications, sched };
}

describe("ActivityDueScheduler", () => {
  it("notifies once per activity: a second run adds nothing", async () => {
    const { prisma, notifications, sched } = setup();
    prisma.seed({ id: "a", dueAt: new Date(NOW.getTime() - 5 * 60_000) });
    expect(await sched.sweep(NOW)).toBe(1);
    expect(await sched.sweep(NOW)).toBe(0);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith("ws", ["u1"], {
      type: "activity_due",
      title: "activity.due",
      body: JSON.stringify({ title: "Call back", contactName: "Ali" }),
      recordKind: "contact",
      recordId: "c1",
    });
    expect(prisma.activities[0].notifiedAt).toEqual(NOW);
  });

  it("uses the ticket as the record when linked", async () => {
    const { prisma, notifications, sched } = setup();
    prisma.seed({ ticketId: "t1", dueAt: new Date(NOW.getTime() - 60_000) });
    await sched.sweep(NOW);
    expect(notifications.notify.mock.calls[0][2]).toMatchObject({ recordKind: "ticket", recordId: "t1" });
  });

  it("skips done, future, unassigned and already-notified activities", async () => {
    const { prisma, notifications, sched } = setup();
    prisma.seed({ doneAt: NOW });
    prisma.seed({ dueAt: new Date(NOW.getTime() + HOUR) });
    prisma.seed({ assigneeId: null });
    prisma.seed({ notifiedAt: NOW });
    expect(await sched.sweep(NOW)).toBe(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("marks activities more than 24h overdue as notified without notifying", async () => {
    const { prisma, notifications, sched } = setup();
    prisma.seed({ id: "old", dueAt: new Date(NOW.getTime() - 25 * HOUR) });
    await sched.sweep(NOW);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(prisma.activities[0].notifiedAt).toEqual(NOW);
  });

  it("loses the compare-and-set race gracefully (no duplicate)", async () => {
    const { prisma, notifications, sched } = setup();
    prisma.seed({ id: "a", dueAt: new Date(NOW.getTime() - 60_000) });
    // another instance claims the row between the read and our update
    const real = prisma.activity.findMany.getMockImplementation()!;
    prisma.activity.findMany.mockImplementationOnce(async (args: any) => {
      const rows = await real(args);
      prisma.activities[0].notifiedAt = NOW;
      return rows;
    });
    expect(await sched.sweep(NOW)).toBe(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("rescheduling re-arms the notification", async () => {
    const { prisma, notifications, sched } = setup();
    const perm = { effective: async () => ({ permissions: ["contacts.update"] }), can: (e: any, p: string) => e.permissions.includes(p) };
    const svc = new ActivitiesService(prisma as never, notifications as never, perm as never);
    const row = prisma.seed({ id: "a", dueAt: new Date(NOW.getTime() - 60_000) });
    await sched.sweep(NOW);
    await svc.update("ws", row.id, { dueAt: new Date(NOW.getTime() - 30_000).toISOString() }, "u1", { userId: "u1" });
    await sched.sweep(NOW);
    expect(notifications.notify).toHaveBeenCalledTimes(2);
  });
});
