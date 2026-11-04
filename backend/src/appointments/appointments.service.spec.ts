import { AppointmentsService } from "./appointments.service";

describe("AppointmentsService.list — filters", () => {
  let prisma: { appointment: { findMany: jest.Mock } };
  let svc: AppointmentsService;

  beforeEach(() => {
    prisma = { appointment: { findMany: jest.fn().mockResolvedValue([]) } };
    svc = new AppointmentsService(prisma as never);
  });

  const whereOf = () => prisma.appointment.findMany.mock.calls[0][0].where;

  it("filters by workspace only when no opts are given", async () => {
    await svc.list("ws1");
    expect(whereOf()).toEqual({ workspaceId: "ws1" });
  });

  it("filters by status", async () => {
    await svc.list("ws1", { status: "confirmed" });
    expect(whereOf()).toEqual({ workspaceId: "ws1", status: "confirmed" });
  });

  it("filters by a date range on startAt", async () => {
    await svc.list("ws1", { from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T00:00:00.000Z" });
    expect(whereOf()).toEqual({
      workspaceId: "ws1",
      startAt: { gte: new Date("2026-09-01T00:00:00.000Z"), lte: new Date("2026-09-30T00:00:00.000Z") },
    });
  });

  it("supports an open-ended 'from' with no 'to'", async () => {
    await svc.list("ws1", { from: "2026-09-01T00:00:00.000Z" });
    expect(whereOf()).toEqual({
      workspaceId: "ws1",
      startAt: { gte: new Date("2026-09-01T00:00:00.000Z"), lte: undefined },
    });
  });

  it("orders by startAt ascending, unchanged from before", async () => {
    await svc.list("ws1");
    expect(prisma.appointment.findMany.mock.calls[0][0].orderBy).toEqual({ startAt: "asc" });
  });
});

describe("AppointmentsService.update — appointment_completed trigger", () => {
  const before = { id: "a1", workspaceId: "ws1", contactId: "c1", status: "confirmed" };
  const after = {
    ...before,
    status: "completed",
    service: "Haircut",
    serviceAr: "قص شعر",
    startAt: new Date("2026-11-03T10:00:00.000Z"),
    durationMin: 30,
    contact: { id: "c1", name: "Lina", phone: "962790000000" },
  };
  let prisma: { appointment: { findFirst: jest.Mock; update: jest.Mock } };
  let events: { emit: jest.Mock };
  let svc: AppointmentsService;

  beforeEach(() => {
    prisma = {
      appointment: { findFirst: jest.fn().mockResolvedValue(before), update: jest.fn().mockResolvedValue(after) },
    };
    events = { emit: jest.fn() };
    svc = new AppointmentsService(prisma as never, undefined, events as never);
  });

  it("fires when an appointment becomes completed, with the contact attached", async () => {
    await svc.update("ws1", "a1", { status: "completed" } as never);
    expect(events.emit).toHaveBeenCalledWith("workflow.trigger", {
      workspaceId: "ws1",
      triggerType: "appointment_completed",
      payload: {
        appointment: {
          id: "a1",
          contactId: "c1",
          service: "Haircut",
          serviceAr: "قص شعر",
          startAt: "2026-11-03T10:00:00.000Z",
          durationMin: 30,
        },
        contact: { id: "c1", name: "Lina", phone: "962790000000" },
      },
    });
  });

  it("does not fire again when an already-completed appointment is edited", async () => {
    prisma.appointment.findFirst.mockResolvedValue({ ...before, status: "completed" });
    await svc.update("ws1", "a1", { note: "tip" } as never);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("does not fire for other status changes", async () => {
    prisma.appointment.update.mockResolvedValue({ ...after, status: "cancelled" });
    await svc.update("ws1", "a1", { status: "cancelled" } as never);
    expect(events.emit).not.toHaveBeenCalled();
  });
});
