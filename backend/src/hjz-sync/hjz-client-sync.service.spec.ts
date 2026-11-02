import { HjzClientSyncService } from "./hjz-client-sync.service";

describe("HjzClientSyncService.pushContact", () => {
  const realFetch = global.fetch;
  let raw: any;
  let svc: HjzClientSyncService;
  let calls: any[];
  let reply: { ok: boolean; status: number; body: unknown };

  const contact = (over: Record<string, unknown> = {}) => ({
    id: "ct-1",
    name: "Lina Haddad",
    phone: "+962790000000",
    tags: '["VIP"]',
    externalSource: "whatsapp",
    hjzClientId: null,
    workspace: { externalTenantId: "tenant-1" },
    ...over,
  });

  beforeEach(() => {
    process.env.HJZ_API_URL = "http://hjz.local/api/v1";
    process.env.HJZ_WEBHOOK_SECRET = "s3cret";
    calls = [];
    reply = { ok: true, status: 200, body: { clientId: "hjz-client-9", created: true } };
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      return { ok: reply.ok, status: reply.status, json: async () => reply.body } as any;
    }) as any;
    raw = {
      contact: {
        findUnique: jest.fn().mockResolvedValue(contact()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    svc = new HjzClientSyncService({ raw } as never);
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.HJZ_API_URL;
    delete process.env.HJZ_WEBHOOK_SECRET;
  });

  it("creates the client in HJZ and stores the returned id", async () => {
    await expect(svc.pushContact("ct-1")).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://hjz.local/api/v1/webhooks/marketing/clients");
    expect(calls[0].headers["x-marketing-secret"]).toBe("s3cret");
    expect(calls[0].body).toEqual({
      event: "contact.created",
      contact: { id: "ct-1", tenantId: "tenant-1", name: "Lina Haddad", phone: "+962790000000", tags: ["VIP"] },
    });
    expect(raw.contact.update).toHaveBeenCalledWith({ where: { id: "ct-1" }, data: { hjzClientId: "hjz-client-9" } });
  });

  it("skips a workspace that is not connected to HJZ", async () => {
    raw.contact.findUnique.mockResolvedValue(contact({ workspace: { externalTenantId: null } }));
    await expect(svc.pushContact("ct-1")).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("never pushes a contact that came from HJZ or is already linked", async () => {
    raw.contact.findUnique.mockResolvedValueOnce(contact({ externalSource: "hjz" }));
    raw.contact.findUnique.mockResolvedValueOnce(contact({ hjzClientId: "x" }));
    expect(await svc.pushContact("ct-1")).toBe(false);
    expect(await svc.pushContact("ct-1")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does not push when another run already claimed the contact", async () => {
    raw.contact.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.pushContact("ct-1")).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("leaves the contact unlinked when HJZ rejects it", async () => {
    reply = { ok: false, status: 404, body: { code: "TENANT_NOT_FOUND" } };
    await expect(svc.pushContact("ct-1")).resolves.toBe(false);
    expect(raw.contact.update).not.toHaveBeenCalled();
  });

  it("is inert when HJZ is not configured", async () => {
    delete process.env.HJZ_API_URL;
    await expect(svc.pushContact("ct-1")).resolves.toBe(false);
    expect(raw.contact.findUnique).not.toHaveBeenCalled();
  });

  it("sweep pushes pending contacts of connected workspaces", async () => {
    raw.contact.findMany.mockResolvedValue([{ id: "ct-1" }]);
    await svc.sweep();
    expect(raw.contact.findMany.mock.calls[0][0].where.workspace).toEqual({ externalTenantId: { not: null } });
    expect(calls).toHaveLength(1);
  });
});
