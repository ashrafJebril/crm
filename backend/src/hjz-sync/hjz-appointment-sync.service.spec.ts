import { HjzAppointmentSyncService } from "./hjz-appointment-sync.service";

describe("HjzAppointmentSyncService", () => {
  const realFetch = global.fetch;
  let raw: any;
  let svc: HjzAppointmentSyncService;
  let calls: any[];
  let reply: { ok: boolean; status: number; body: unknown };
  const updatedAt = new Date("2026-10-24T10:00:00Z");
  const appt = (over: Record<string, unknown> = {}) => ({
    id: "ap-1",
    workspaceId: "ws-1",
    contactId: "ct-1",
    staffId: "u-1",
    service: "Haircut",
    serviceAr: "قص شعر",
    startAt: new Date("2026-11-02T09:15:00Z"),
    durationMin: 45,
    status: "confirmed",
    note: "first visit",
    hjzAppointmentId: null,
    updatedAt,
    ...over,
  });

  beforeEach(() => {
    process.env.HJZ_API_URL = "http://hjz.local/api/v1";
    process.env.HJZ_WEBHOOK_SECRET = "s3cret";
    calls = [];
    reply = { ok: true, status: 200, body: { appointmentId: "hjz-ap-9", clientId: "hjz-c-1", warnings: [] } };
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: reply.ok, status: reply.status, json: async () => reply.body } as any;
    }) as any;
    raw = {
      appointment: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(appt()),
        findMany: jest.fn().mockResolvedValue([]),
      },
      workspace: { findUnique: jest.fn().mockResolvedValue({ externalTenantId: "tenant-1" }) },
      contact: {
        findUnique: jest.fn().mockResolvedValue({ id: "ct-1", name: "Lina", phone: "+962790000000", hjzClientId: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ externalId: "hjz-user-7", kewyAccountId: null }) },
    };
    svc = new HjzAppointmentSyncService({ raw } as never);
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.HJZ_API_URL;
    delete process.env.HJZ_WEBHOOK_SECRET;
  });

  it("pushes the booking's full state and stores the HJZ ids", async () => {
    await expect(svc.push("ap-1")).resolves.toBe(true);
    expect(calls[0].url).toBe("http://hjz.local/api/v1/webhooks/marketing/appointments");
    expect(calls[0].body).toEqual({
      event: "appointment.upserted",
      appointment: {
        id: "ap-1",
        tenantId: "tenant-1",
        contact: { id: "ct-1", name: "Lina", phone: "+962790000000", hjzClientId: null },
        service: "Haircut",
        serviceAr: "قص شعر",
        startAt: "2026-11-02T09:15:00.000Z",
        durationMin: 45,
        status: "confirmed",
        note: "first visit",
        staff: { hjzUserId: "hjz-user-7", kewyAccountId: null },
      },
    });
    expect(raw.appointment.updateMany).toHaveBeenLastCalledWith({
      where: { id: "ap-1", updatedAt },
      data: { hjzSyncPending: false, hjzSyncError: null },
    });
    expect(raw.appointment.update).toHaveBeenCalledWith({ where: { id: "ap-1" }, data: { hjzAppointmentId: "hjz-ap-9" } });
    expect(raw.contact.updateMany).toHaveBeenCalledWith({
      where: { id: "ct-1", hjzClientId: null },
      data: { hjzClientId: "hjz-c-1" },
    });
  });

  it("keeps HJZ's reason and stays pending when HJZ refuses", async () => {
    reply = { ok: false, status: 422, body: { code: "CRM_SYNC_SERVICE_NOT_FOUND", message: 'No hjz service named "Haircut"' } };
    await expect(svc.push("ap-1")).resolves.toBe(false);
    expect(raw.appointment.update).toHaveBeenCalledWith({
      where: { id: "ap-1" },
      data: { hjzSyncError: 'CRM_SYNC_SERVICE_NOT_FOUND: No hjz service named "Haircut"' },
    });
    expect(raw.appointment.updateMany).toHaveBeenCalledTimes(1); // the claim only — not cleared
  });

  it("does not push a booking another run already claimed", async () => {
    raw.appointment.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.push("ap-1")).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("clears pending without pushing when the workspace is not connected", async () => {
    raw.workspace.findUnique.mockResolvedValue({ externalTenantId: null });
    await expect(svc.push("ap-1")).resolves.toBe(false);
    expect(calls).toHaveLength(0);
    expect(raw.appointment.update).toHaveBeenCalledWith({ where: { id: "ap-1" }, data: { hjzSyncPending: false } });
  });

  it("changed() marks the booking pending and pushes it", async () => {
    await svc.changed("ap-1");
    expect(raw.appointment.update).toHaveBeenCalledWith({
      where: { id: "ap-1" },
      data: { hjzSyncPending: true, hjzSyncAttemptAt: null },
    });
    expect(calls).toHaveLength(1);
  });

  it("deleted() cancels the HJZ mirror", async () => {
    await svc.deleted(appt({ hjzAppointmentId: "hjz-ap-9" }) as any);
    expect(calls[0].body.appointment.status).toBe("cancelled");
  });

  it("deleted() does nothing for a booking HJZ never had", async () => {
    await svc.deleted(appt() as any);
    expect(calls).toHaveLength(0);
  });
});
