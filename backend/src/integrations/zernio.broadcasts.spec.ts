import { ZernioClient } from "./zernio.client";

describe("ZernioClient broadcasts", () => {
  let client: ZernioClient;
  let fetchMock: jest.Mock;
  const reply = (body: unknown) =>
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
  };

  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "test-key";
    delete process.env.ZERNIO_BASE_URL;
    client = new ZernioClient();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("imports contacts in bulk with their names", async () => {
    reply({ success: true, created: 2, skipped: 0, errors: [], total: 2 });
    const res = await client.bulkCreateContacts("prof1", "acc1", [
      { name: "Lina", platformIdentifier: "+962790000001" },
      { name: "Omar", platformIdentifier: "+962790000002" },
    ]);
    expect(call()).toEqual({
      url: "https://zernio.com/api/v1/contacts/bulk",
      method: "POST",
      body: {
        profileId: "prof1",
        accountId: "acc1",
        platform: "whatsapp",
        contacts: [
          { name: "Lina", platformIdentifier: "+962790000001" },
          { name: "Omar", platformIdentifier: "+962790000002" },
        ],
      },
    });
    expect(res).toEqual({ created: 2, skipped: 0, errors: 0 });
  });

  it("creates a WhatsApp template broadcast with numbered parameters and a variable mapping", async () => {
    reply({ success: true, broadcast: { id: "b1", status: "draft" } });
    const id = await client.createWhatsAppBroadcast({
      profileId: "prof1",
      accountId: "acc1",
      name: "Eid offer",
      template: { name: "eid_offer", language: "ar" },
      variables: [{ field: "name" }, { field: "custom", customValue: "20%" }],
    });
    expect(id).toBe("b1");
    expect(call()).toEqual({
      url: "https://zernio.com/api/v1/broadcasts",
      method: "POST",
      body: {
        profileId: "prof1",
        accountId: "acc1",
        platform: "whatsapp",
        name: "Eid offer",
        template: {
          name: "eid_offer",
          language: "ar",
          components: [{ type: "body", parameters: [{ type: "text", text: "{{1}}" }, { type: "text", text: "{{2}}" }] }],
          variableMapping: { "1": { field: "name" }, "2": { field: "custom", customValue: "20%" } },
        },
      },
    });
  });

  it("leaves components out for a template without variables (Meta 400s on an empty list)", async () => {
    reply({ success: true, broadcast: { id: "b2" } });
    await client.createWhatsAppBroadcast({
      profileId: "p",
      accountId: "a",
      name: "n",
      template: { name: "hello", language: "en" },
      variables: [],
    });
    expect(call().body.template).toEqual({ name: "hello", language: "en" });
  });

  it("adds phone recipients", async () => {
    reply({ success: true, added: 2, skipped: 1 });
    const res = await client.addBroadcastRecipients("b1", ["+962790000001", "+962790000002"]);
    expect(call()).toEqual({
      url: "https://zernio.com/api/v1/broadcasts/b1/recipients",
      method: "POST",
      body: { phones: ["+962790000001", "+962790000002"] },
    });
    expect(res).toEqual({ added: 2, skipped: 1 });
  });

  it("sends, schedules and cancels", async () => {
    reply({ success: true, status: "sending", sent: 2, failed: 0, recipientCount: 2 });
    reply({ success: true, broadcast: { id: "b1", status: "scheduled" } });
    reply({ success: true, broadcast: { id: "b1", status: "cancelled" } });
    await client.sendBroadcast("b1");
    await client.scheduleBroadcast("b1", "2026-12-01T09:00:00.000Z");
    await client.cancelBroadcast("b1");
    expect(call(0)).toMatchObject({ url: "https://zernio.com/api/v1/broadcasts/b1/send", method: "POST" });
    expect(call(1)).toEqual({
      url: "https://zernio.com/api/v1/broadcasts/b1/schedule",
      method: "POST",
      body: { scheduledAt: "2026-12-01T09:00:00.000Z" },
    });
    expect(call(2)).toMatchObject({ url: "https://zernio.com/api/v1/broadcasts/b1/cancel", method: "POST" });
  });

  it("reads a broadcast's status and delivery counters", async () => {
    reply({
      success: true,
      broadcast: {
        id: "b1",
        status: "completed",
        recipientCount: 10,
        sentCount: 9,
        deliveredCount: 8,
        readCount: 5,
        failedCount: 1,
      },
    });
    const b = await client.getBroadcast("b1");
    expect(call()).toMatchObject({ url: "https://zernio.com/api/v1/broadcasts/b1", method: "GET" });
    expect(b).toEqual({ status: "completed", recipientCount: 10, sent: 9, delivered: 8, read: 5, failed: 1 });
  });
});

describe("ZernioClient errors", () => {
  it("explains a WhatsApp connection Meta has revoked", async () => {
    process.env.ZERNIO_API_KEY = "test-key";
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(JSON.stringify({ error: "WhatsApp account not found" })),
    }) as unknown as typeof fetch;
    const err = await new ZernioClient().whatsappTemplates("acc1").catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(err.message).toMatch(/removed by Meta.*Reconnect WhatsApp in Settings/);
  });
});
