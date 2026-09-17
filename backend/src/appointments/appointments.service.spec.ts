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
