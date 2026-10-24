import { HjzWebhooksService } from "./hjz-webhooks.service";

describe("HjzWebhooksService.handle — client linking", () => {
  let prisma: any;
  let svc: HjzWebhooksService;
  const client = { id: "hjz-c1", tenantId: "tenant-1", name: "Lina Haddad", phone: "+962790000000", tags: ["VIP"] };

  beforeEach(() => {
    prisma = {
      workspace: { upsert: jest.fn().mockResolvedValue({ id: "ws-1" }), findUnique: jest.fn() },
      contact: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    svc = new HjzWebhooksService(prisma as never);
  });

  it("creates a new hjz contact carrying the link", async () => {
    await svc.handle({ event: "client.upserted", client });
    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        externalSource: "hjz",
        externalId: "hjz-c1",
        hjzClientId: "hjz-c1",
        lifecycle: "customer",
      }),
    });
  });

  it("updates a CRM-born contact linked to the client without touching its source/lifecycle", async () => {
    prisma.contact.findFirst.mockResolvedValueOnce({ id: "ct-1", externalSource: "whatsapp" });
    await svc.handle({ event: "client.upserted", client });
    expect(prisma.contact.create).not.toHaveBeenCalled();
    const data = prisma.contact.update.mock.calls[0][0].data;
    expect(data).toEqual({
      hjzClientId: "hjz-c1",
      name: "Lina Haddad",
      phone: "+962790000000",
      tags: '["VIP"]',
    });
  });

  it("links an unlinked contact with the same phone instead of duplicating it", async () => {
    prisma.contact.findFirst
      .mockResolvedValueOnce(null) // by hjzClientId
      .mockResolvedValueOnce(null) // legacy externalId
      .mockResolvedValueOnce({ id: "ct-2", externalSource: null }); // by phone
    await svc.handle({ event: "client.upserted", client });
    expect(prisma.contact.findFirst.mock.calls[2][0].where).toEqual({
      workspaceId: "ws-1",
      hjzClientId: null,
      phone: "+962790000000",
    });
    expect(prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ct-2" }, data: expect.objectContaining({ hjzClientId: "hjz-c1" }) }),
    );
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  it("churns the contact on client.opted_out", async () => {
    prisma.contact.findFirst.mockResolvedValueOnce({ id: "ct-1", externalSource: "hjz" });
    await svc.handle({
      event: "client.opted_out",
      client: { ...client, phone: null, acceptsMarketingEmail: false, acceptsMarketingWhatsapp: false },
    });
    expect(prisma.contact.update).toHaveBeenCalledWith({ where: { id: "ct-1" }, data: { lifecycle: "churned" } });
  });
});

describe("HjzClientWebhookDto — the payload hjz actually sends", () => {
  // Same options as the global pipe in main.ts.
  const pipe = new (require("@nestjs/common").ValidationPipe)({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const { HjzClientWebhookDto } = require("./hjz-webhooks.dto");
  const run = (body: unknown) => pipe.transform(body, { type: "body", metatype: HjzClientWebhookDto });

  it("accepts consent flags and client.opted_out", async () => {
    const client = {
      id: "c1", tenantId: "t1", name: "Lina", email: null, phone: "+962790000000",
      acceptsMarketingEmail: true, acceptsMarketingWhatsapp: false, tags: [], blocked: false, deletedAt: null,
    };
    await expect(run({ event: "client.upserted", client })).resolves.toBeDefined();
    await expect(run({ event: "client.opted_out", client })).resolves.toBeDefined();
  });
});
