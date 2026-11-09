import { CampaignSendService } from "./campaign-send.service";
import { makeFakePrisma } from "../channels/test-prisma";
import { RecipientTrackerService } from "./tracking/recipient-tracker.service";

describe("CampaignSendService", () => {
  let prisma: any;
  let zernio: any;
  let isLocked: jest.Mock;
  let svc: CampaignSendService;

  const draft = {
    id: "camp1",
    workspaceId: "ws1",
    name: "Eid offer",
    status: "draft",
    segmentId: "seg1",
    templateId: "tpl1",
    zernioBroadcastId: null,
  };
  const contacts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `ct${i}`, name: `C${i}`, phone: `9627900${String(i).padStart(5, "0")}`, lifecycle: "lead" }));

  beforeEach(() => {
    prisma = {
      campaign: {
        findFirst: jest.fn().mockResolvedValue(draft),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...draft, ...data })),
        findMany: jest.fn().mockResolvedValue([]),
      },
      template: {
        findFirst: jest.fn().mockResolvedValue({ id: "tpl1", name: "eid_offer", lang: "ar", status: "approved", body: "Hi {{1}}, {{2}} off" }),
      },
      workspace: { findUnique: jest.fn().mockResolvedValue({ zernioProfileId: "prof1" }) },
      // SP-19: no mirrored channel yet, so the legacy Integration row is used.
      channel: { findFirst: jest.fn().mockResolvedValue(null) },
      integration: { findFirst: jest.fn().mockResolvedValue({ pageId: "acc1" }), findMany: jest.fn().mockResolvedValue([]) },
      contact: { findMany: jest.fn().mockResolvedValue([...contacts(3), { id: "ctX", name: "X", phone: null, lifecycle: "lead" }]) },
      campaignRecipient: {
        createMany: jest.fn().mockImplementation(({ data }) => Promise.resolve({ count: data.length })),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    zernio = {
      bulkCreateContacts: jest.fn().mockResolvedValue({ created: 3, skipped: 0, errors: 0 }),
      createWhatsAppBroadcast: jest.fn().mockResolvedValue("b1"),
      addBroadcastRecipients: jest.fn().mockImplementation((_id, phones) => Promise.resolve({ added: phones.length, skipped: 0 })),
      sendBroadcast: jest.fn().mockResolvedValue(undefined),
      scheduleBroadcast: jest.fn().mockResolvedValue(undefined),
      cancelBroadcast: jest.fn().mockResolvedValue(undefined),
      getBroadcast: jest.fn(),
    };
    isLocked = jest.fn().mockResolvedValue(false);
    svc = new CampaignSendService(prisma, zernio, { isLocked } as never);
  });

  const vars = [{ field: "name" as const }, { field: "custom" as const, customValue: "20%" }];

  describe("launch", () => {
    it("imports the audience, creates the broadcast and sends it now", async () => {
      const res = await svc.launch("ws1", "camp1", { mode: "now", variables: vars });
      expect(prisma.contact.findMany).toHaveBeenCalledWith({
        where: { workspaceId: "ws1", segmentMembers: { some: { segmentId: "seg1" } } },
        select: { id: true, name: true, phone: true, lifecycle: true, marketingOptOut: true },
      });
      expect(zernio.bulkCreateContacts).toHaveBeenCalledWith("prof1", "acc1", [
        { name: "C0", platformIdentifier: "+962790000000" },
        { name: "C1", platformIdentifier: "+962790000001" },
        { name: "C2", platformIdentifier: "+962790000002" },
      ]);
      expect(zernio.createWhatsAppBroadcast).toHaveBeenCalledWith({
        profileId: "prof1",
        accountId: "acc1",
        name: "Eid offer",
        template: { name: "eid_offer", language: "ar" },
        variables: vars,
      });
      expect(zernio.addBroadcastRecipients).toHaveBeenCalledWith("b1", ["+962790000000", "+962790000001", "+962790000002"]);
      expect(zernio.sendBroadcast).toHaveBeenCalledWith("b1");
      const data = prisma.campaign.update.mock.calls.at(-1)[0].data;
      expect(data).toMatchObject({ status: "running", zernioBroadcastId: "b1", recipients: 3, skipped: 1, lastError: null });
      expect(res.status).toBe("running");
    });

    it("targets every contact when the campaign has no segment", async () => {
      prisma.campaign.findFirst.mockResolvedValue({ ...draft, segmentId: null });
      await svc.launch("ws1", "camp1", { mode: "now", variables: vars });
      expect(prisma.contact.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws1" });
    });

    it("batches recipients 100 at a time and contacts 1,000 at a time", async () => {
      prisma.contact.findMany.mockResolvedValue(contacts(1150));
      await svc.launch("ws1", "camp1", { mode: "now", variables: vars });
      expect(zernio.bulkCreateContacts).toHaveBeenCalledTimes(2);
      expect(zernio.addBroadcastRecipients).toHaveBeenCalledTimes(12);
    });

    it("schedules for a future time", async () => {
      const when = new Date(Date.now() + 3_600_000).toISOString();
      const res = await svc.launch("ws1", "camp1", { mode: "schedule", scheduledAt: when, variables: vars });
      expect(zernio.scheduleBroadcast).toHaveBeenCalledWith("b1", when);
      expect(zernio.sendBroadcast).not.toHaveBeenCalled();
      expect(res.status).toBe("scheduled");
      expect(prisma.campaign.update.mock.calls.at(-1)[0].data.scheduledAt).toEqual(new Date(when));
    });

    it("rejects a schedule in the past", async () => {
      await expect(
        svc.launch("ws1", "camp1", { mode: "schedule", scheduledAt: "2020-01-01T00:00:00.000Z", variables: vars }),
      ).rejects.toThrow(/future/);
    });

    it("SP-19 m6: with no WhatsApp sender it points to Channels, not Settings → Integrations", async () => {
      prisma.integration.findFirst.mockResolvedValue(null);
      const err = await svc.launch("ws1", "camp1", { mode: "now", variables: vars }).catch((e) => e);
      expect(err.message).toMatch(/Channels/);
      expect(err.message).not.toMatch(/Integrations/);
    });

    it("refuses while the workspace is locked for an unpaid subscription", async () => {
      isLocked.mockResolvedValue(true);
      await expect(svc.launch("ws1", "camp1", { mode: "now", variables: vars })).rejects.toThrow(/payment/i);
      expect(zernio.createWhatsAppBroadcast).not.toHaveBeenCalled();
    });

    it("requires an approved template", async () => {
      prisma.template.findFirst.mockResolvedValue({ name: "t", lang: "en", status: "pending", body: "x" });
      await expect(svc.launch("ws1", "camp1", { mode: "now", variables: [] })).rejects.toThrow(/approved/);
    });

    it("requires one value per template variable", async () => {
      await expect(svc.launch("ws1", "camp1", { mode: "now", variables: [{ field: "name" }] })).rejects.toThrow(/2 variables/);
    });

    it("requires WhatsApp to be connected through Zernio", async () => {
      prisma.integration.findFirst.mockResolvedValue(null);
      await expect(svc.launch("ws1", "camp1", { mode: "now", variables: vars })).rejects.toThrow(/WhatsApp/);
    });

    it("refuses an audience nobody can be reached in", async () => {
      prisma.contact.findMany.mockResolvedValue([{ name: "X", phone: null, lifecycle: "lead" }]);
      await expect(svc.launch("ws1", "camp1", { mode: "now", variables: vars })).rejects.toThrow(/No one in this audience/);
    });

    it("only launches drafts", async () => {
      prisma.campaign.findFirst.mockResolvedValue({ ...draft, status: "running", zernioBroadcastId: "b0" });
      await expect(svc.launch("ws1", "camp1", { mode: "now", variables: vars })).rejects.toThrow(/already/);
    });

    it("marks the campaign failed with Zernio's reason when sending breaks", async () => {
      zernio.sendBroadcast.mockRejectedValue(new Error("Template parameter count mismatch"));
      await expect(svc.launch("ws1", "camp1", { mode: "now", variables: vars })).rejects.toThrow(/mismatch/);
      const data = prisma.campaign.update.mock.calls.at(-1)[0].data;
      expect(data).toMatchObject({ status: "failed", lastError: "Template parameter count mismatch", zernioBroadcastId: "b1" });
    });

    it("launch writes recipients in chunks of 1000 before calling Zernio", async () => {
      prisma.contact.findMany.mockResolvedValue([
        ...contacts(2500),
        { id: "o1", name: "Out1", phone: "962791000001", lifecycle: "lead", marketingOptOut: true },
        { id: "o2", name: "Out2", phone: "962791000002", lifecycle: "churned" },
        { id: "o3", name: "Out3", phone: null, lifecycle: "lead", marketingOptOut: true },
        { id: "n1", name: "NoPhone1", phone: null, lifecycle: "lead" },
        { id: "n2", name: "NoPhone2", phone: "0790000000", lifecycle: "lead" },
      ]);
      await svc.launch("ws1", "camp1", { mode: "now", variables: vars });
      const calls = prisma.campaignRecipient.createMany.mock.calls.map((c: any[]) => c[0]);
      expect(calls).toHaveLength(4);
      for (const c of calls) expect(c.skipDuplicates).toBe(true);
      expect(calls.map((c: any) => c.data.length)).toEqual([1000, 1000, 500, 5]);
      for (const c of calls.slice(0, 3)) for (const r of c.data) expect(r).toMatchObject({ status: "queued", workspaceId: "ws1", campaignId: "camp1" });
      expect(calls[0].data[0]).toEqual({
        workspaceId: "ws1",
        campaignId: "camp1",
        contactId: "ct0",
        channelId: null,
        phone: "+962790000000",
        contactName: "C0",
        status: "queued",
      });
      const skippedRows = calls[3].data;
      expect(skippedRows.map((r: any) => [r.contactId, r.status, r.failureCode, r.phone])).toEqual([
        ["o1", "skipped", "skip:opted_out", "+962791000001"],
        ["o2", "skipped", "skip:opted_out", "+962791000002"],
        ["o3", "skipped", "skip:opted_out", null],
        ["n1", "skipped", "skip:no_phone", null],
        ["n2", "skipped", "skip:no_phone", null],
      ]);
      // Rows are written before Zernio is called.
      const lastWrite = Math.max(...prisma.campaignRecipient.createMany.mock.invocationCallOrder);
      expect(lastWrite).toBeLessThan(zernio.createWhatsAppBroadcast.mock.invocationCallOrder[0]);
      expect(lastWrite).toBeLessThan(zernio.bulkCreateContacts.mock.invocationCallOrder[0]);
      const trackingSet = prisma.campaign.update.mock.calls.findIndex((c: any[]) => c[0].data.recipientTracking === true);
      expect(trackingSet).toBeGreaterThanOrEqual(0);
      expect(prisma.campaign.update.mock.invocationCallOrder[trackingSet]).toBeLessThan(zernio.bulkCreateContacts.mock.invocationCallOrder[0]);
      expect(prisma.campaign.update.mock.calls.at(-1)[0].data).toMatchObject({ recipients: 2500, skipped: 5, status: "running" });
    });

    it("launch with 100k recipients never inserts more than 1000 rows per call", async () => {
      prisma.contact.findMany.mockResolvedValue(
        Array.from({ length: 100_000 }, (_, i) => ({ id: `k${i}`, name: `K${i}`, phone: `+9627${String(i).padStart(8, "0")}`, lifecycle: "lead" })),
      );
      await svc.launch("ws1", "camp1", { mode: "now", variables: vars });
      const sizes = prisma.campaignRecipient.createMany.mock.calls.map((c: any[]) => c[0].data.length);
      expect(sizes).toHaveLength(100);
      expect(Math.max(...sizes)).toBe(1000);
      expect(sizes.reduce((a: number, b: number) => a + b, 0)).toBe(100_000);
      // No per-recipient round-trips (ruling 10): only the chunked createMany.
      expect(Object.keys(prisma.campaignRecipient)).toEqual(["createMany", "deleteMany"]);
      expect(prisma.campaignRecipient.deleteMany).not.toHaveBeenCalled();
    });

    it("launch failure leaves recipients queued and campaign failed", async () => {
      zernio.sendBroadcast.mockRejectedValue(new Error("Zernio down"));
      await expect(svc.launch("ws1", "camp1", { mode: "now", variables: vars })).rejects.toThrow(/Zernio down/);
      expect(prisma.campaignRecipient.createMany).toHaveBeenCalled();
      expect(prisma.campaignRecipient.deleteMany).not.toHaveBeenCalled();
      expect(prisma.campaign.update.mock.calls.at(-1)[0].data).toMatchObject({ status: "failed", zernioBroadcastId: "b1" });
    });

    it("a retried draft launch clears the rows an interrupted attempt left behind first", async () => {
      prisma.campaign.findFirst.mockResolvedValue({ ...draft, recipientTracking: true });
      await svc.launch("ws1", "camp1", { mode: "now", variables: vars });
      expect(prisma.campaignRecipient.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws1", campaignId: "camp1" } });
      expect(prisma.campaignRecipient.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.campaignRecipient.createMany.mock.invocationCallOrder[0],
      );
    });

    it("records the sending channel on every row", async () => {
      prisma.channel.findFirst.mockResolvedValue({ id: "chA", externalId: "accA", kind: "whatsapp", provider: "zernio", status: "active" });
      await svc.launch("ws1", "camp1", { mode: "now", variables: vars });
      expect(zernio.createWhatsAppBroadcast.mock.calls[0][0].accountId).toBe("accA");
      for (const c of prisma.campaignRecipient.createMany.mock.calls) for (const r of c[0].data) expect(r.channelId).toBe("chA");
    });

    it("opted-out contact is skipped by campaign send (with a skipped row)", async () => {
      prisma.contact.findMany.mockResolvedValue([
        { id: "lina", name: "Lina", phone: "962790000001", lifecycle: "lead", marketingOptOut: true },
        { id: "omar", name: "Omar", phone: "962790000002", lifecycle: "lead", marketingOptOut: false },
      ]);
      await svc.launch("ws1", "camp1", { mode: "now", variables: vars });
      expect(zernio.addBroadcastRecipients).toHaveBeenCalledWith("b1", ["+962790000002"]);
      const rows = prisma.campaignRecipient.createMany.mock.calls.flatMap((c: any[]) => c[0].data);
      expect(rows.find((r: any) => r.contactId === "lina")).toMatchObject({ status: "skipped", failureCode: "skip:opted_out" });
      expect(rows.find((r: any) => r.contactId === "omar")).toMatchObject({ status: "queued" });
    });
  });

  describe("preview", () => {
    it("counts who can be reached and estimates Meta's charge", async () => {
      const res = await svc.preview("ws1", "seg1");
      expect(res).toEqual({
        total: 4,
        reachable: 3,
        skipped: { noPhone: 1, optedOut: 0, duplicate: 0 },
        estimate: { usd: expect.closeTo(0.1176, 6), unpriced: 0 },
      });
    });
  });

  describe("cancel", () => {
    it("cancels a running broadcast", async () => {
      prisma.campaign.findFirst.mockResolvedValue({ ...draft, status: "running", zernioBroadcastId: "b1" });
      const res = await svc.cancel("ws1", "camp1");
      expect(zernio.cancelBroadcast).toHaveBeenCalledWith("b1");
      expect(res.status).toBe("cancelled");
    });

    it("refuses to cancel a campaign that never launched", async () => {
      await expect(svc.cancel("ws1", "camp1")).rejects.toThrow(/not sending/);
    });
  });

  describe("syncActive", () => {
    it("copies Zernio's counters and status onto active campaigns", async () => {
      prisma.campaign.findMany.mockResolvedValue([{ id: "camp1", workspaceId: "ws1", zernioBroadcastId: "b1" }]);
      zernio.getBroadcast.mockResolvedValue({ status: "completed", recipientCount: 3, sent: 3, delivered: 2, read: 1, failed: 0 });
      await svc.syncActive();
      expect(prisma.campaign.findMany.mock.calls[0][0].where.zernioBroadcastId).toEqual({ not: null });
      expect(prisma.campaign.update).toHaveBeenCalledWith({
        where: { id: "camp1" },
        data: expect.objectContaining({ status: "completed", sent: 3, delivered: 2, read: 1, failed: 0 }),
      });
    });

    it("keeps going when one broadcast can't be read", async () => {
      prisma.campaign.findMany.mockResolvedValue([
        { id: "a", workspaceId: "ws1", zernioBroadcastId: "b1" },
        { id: "b", workspaceId: "ws1", zernioBroadcastId: "b2" },
      ]);
      zernio.getBroadcast
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce({ status: "sending", recipientCount: 1, sent: 1, delivered: 0, read: 0, failed: 0 });
      await svc.syncActive();
      expect(prisma.campaign.update).toHaveBeenCalledTimes(1);
      expect(prisma.campaign.update.mock.calls[0][0].where).toEqual({ id: "b" });
    });
  });
});

describe("broadcast sweep maps Zernio recipients monotonically and resumes from skip", () => {
  const NOW = new Date("2026-11-09T12:00:00.000Z");
  const iso = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
  const rowFor = (id: string, phone: string, over: Record<string, unknown> = {}) => ({
    id,
    workspaceId: "ws1",
    campaignId: "camp1",
    contactId: null,
    channelId: "chA",
    phone,
    contactName: id,
    status: "queued",
    messageId: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    repliedAt: null,
    failureCode: null,
    failureReason: null,
    createdAt: new Date(NOW.getTime() - 3_600_000),
    updatedAt: new Date(NOW.getTime() - 3_600_000),
    ...over,
  });
  const zr = (phone: string, over: Record<string, unknown> = {}) => ({
    id: `z-${phone}`,
    contactId: null,
    channelId: "zch",
    platformIdentifier: phone,
    contactName: null,
    status: "pending",
    messageId: null,
    error: null,
    errorCode: null,
    errorExplanation: null,
    errorTraceId: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    ...over,
  });

  function build(campaignOver: Record<string, unknown> = {}) {
    const prisma = makeFakePrisma({
      campaign: [
        {
          id: "camp1",
          workspaceId: "ws1",
          name: "Eid",
          status: "running",
          zernioBroadcastId: "b1",
          recipientTracking: true,
          recipientSyncSkip: 0,
          recipientsSyncedAt: null,
          launchedAt: new Date(NOW.getTime() - 3_600_000),
          sent: 0,
          delivered: 0,
          read: 0,
          failed: 0,
          replied: 0,
          ...campaignOver,
        },
      ],
      campaignRecipient: [
        rowFor("p", "+962790000001"),
        rowFor("s", "+962790000002"),
        rowFor("d", "+962790000003"),
        rowFor("r", "+962790000004", { status: "replied", repliedAt: new Date(NOW.getTime() - 60_000) }),
        rowFor("f", "+962790000005"),
        rowFor("x", "+962790000006", { status: "skipped", failureCode: "skip:opted_out" }),
      ],
    });
    const zernio = {
      getBroadcast: jest.fn().mockResolvedValue({ status: "sending", recipientCount: 6, sent: 9, delivered: 9, read: 9, failed: 9 }),
      listBroadcastRecipients: jest.fn(),
    };
    const svc = new CampaignSendService(prisma, zernio as never, { isLocked: jest.fn() } as never, new RecipientTrackerService(prisma));
    return { prisma, zernio, svc };
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    delete process.env.ZERNIO_RECIPIENT_PAGE;
    delete process.env.RECIPIENT_SYNC_MAX_PAGES;
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.ZERNIO_RECIPIENT_PAGE;
    delete process.env.RECIPIENT_SYNC_MAX_PAGES;
  });

  it("maps pending/sent/delivered/read/failed rows, advances skip and resets it on hasMore:false, then recounts", async () => {
    process.env.RECIPIENT_SYNC_MAX_PAGES = "1";
    const { prisma, zernio, svc } = build();
    const page1 = [
      zr("962790000001"),
      zr("+962790000002", { status: "sent", messageId: "wamid.S", sentAt: iso(50) }),
      zr("962790000003", { status: "delivered", messageId: "wamid.D", sentAt: iso(50), deliveredAt: iso(49) }),
    ];
    const page2 = [
      zr("962790000004", { status: "read", messageId: "wamid.R", sentAt: iso(50), deliveredAt: iso(49), readAt: iso(40) }),
      zr("962790000005", {
        status: "failed",
        sentAt: iso(50),
        error: "Message failed to send",
        errorCode: 131026,
        errorExplanation: "Message undeliverable.\nThe number may not be on WhatsApp.",
      }),
      zr("962790000006", { status: "sent", sentAt: iso(50) }),
      zr("962799999999", { status: "read" }), // unknown phone: ignored
    ];
    zernio.listBroadcastRecipients
      .mockResolvedValueOnce({ recipients: page1, pagination: { total: 7, limit: 100, skip: 0, hasMore: true }, summary: {} })
      .mockResolvedValueOnce({ recipients: page2, pagination: { total: 7, limit: 100, skip: 3, hasMore: false }, summary: {} });

    await svc.syncActive();
    expect(zernio.listBroadcastRecipients).toHaveBeenLastCalledWith("b1", { skip: 0, limit: 100 });
    const camp = prisma.db.campaign[0];
    expect(camp.recipientSyncSkip).toBe(3);
    expect(camp.recipientsSyncedAt).toBeNull();
    // Tracked: Zernio's status is copied, its aggregate counters are not.
    expect(camp.status).toBe("running");
    expect(camp.sent).toBe(0);

    await svc.syncActive();
    expect(zernio.listBroadcastRecipients).toHaveBeenLastCalledWith("b1", { skip: 3, limit: 100 });
    expect(camp.recipientSyncSkip).toBe(0);
    expect(camp.recipientsSyncedAt).toEqual(NOW);

    const by = Object.fromEntries(prisma.db.campaignRecipient.map((r: any) => [r.id, r]));
    expect(by.p).toMatchObject({ status: "queued", messageId: null, sentAt: null });
    expect(by.s).toMatchObject({ status: "sent", messageId: "wamid.S", sentAt: new Date(iso(50)) });
    expect(by.d).toMatchObject({ status: "delivered", sentAt: new Date(iso(50)), deliveredAt: new Date(iso(49)) });
    // Already replied: the status never moves back, but the timestamps fill in.
    expect(by.r).toMatchObject({ status: "replied", readAt: new Date(iso(40)), messageId: "wamid.R" });
    expect(by.f).toMatchObject({
      status: "failed",
      failureCode: "meta:131026",
      failureReason: "Message undeliverable. The number may not be on WhatsApp.",
    });
    expect(by.x).toMatchObject({ status: "skipped", sentAt: null });
    // Counters recomputed from rows: sent = s+d+r, delivered = d+r, read = r, replied = r, failed = f.
    expect(camp).toMatchObject({ sent: 3, delivered: 2, read: 1, replied: 1, failed: 1 });

    // A replay of the same pages changes nothing.
    const before = JSON.stringify(prisma.db.campaignRecipient);
    zernio.listBroadcastRecipients.mockResolvedValueOnce({
      recipients: [...page1, ...page2],
      pagination: { total: 7, limit: 100, skip: 0, hasMore: false },
      summary: {},
    });
    await svc.syncActive();
    expect(JSON.stringify(prisma.db.campaignRecipient)).toBe(before);
  });

  it("pages up to RECIPIENT_SYNC_MAX_PAGES per tick with ZERNIO_RECIPIENT_PAGE rows each", async () => {
    process.env.ZERNIO_RECIPIENT_PAGE = "2";
    process.env.RECIPIENT_SYNC_MAX_PAGES = "2";
    const { prisma, zernio, svc } = build();
    zernio.listBroadcastRecipients.mockImplementation(async (_b: string, { skip }: { skip: number }) => ({
      recipients: [zr(`9627900000${String(skip + 1).padStart(2, "0")}`), zr(`9627900000${String(skip + 2).padStart(2, "0")}`)],
      pagination: { total: 10, limit: 2, skip, hasMore: true },
      summary: {},
    }));
    await svc.syncActive();
    expect(zernio.listBroadcastRecipients.mock.calls.map((c: any[]) => c[1])).toEqual([
      { skip: 0, limit: 2 },
      { skip: 2, limit: 2 },
    ]);
    expect(prisma.db.campaign[0].recipientSyncSkip).toBe(4);
  });

  it("an untracked campaign still gets Zernio's aggregate counters and no sweep", async () => {
    const { prisma, zernio, svc } = build({ recipientTracking: false });
    await svc.syncActive();
    expect(zernio.listBroadcastRecipients).not.toHaveBeenCalled();
    expect(prisma.db.campaign[0]).toMatchObject({ sent: 9, delivered: 9, read: 9, failed: 9 });
  });

  it("finished tracked campaigns keep being swept for 72 hours after launch, without a status read", async () => {
    const recent = build({ status: "completed", launchedAt: new Date(NOW.getTime() - 71 * 3_600_000) });
    recent.zernio.listBroadcastRecipients.mockResolvedValue({ recipients: [], pagination: { total: 0, limit: 100, skip: 0, hasMore: false }, summary: {} });
    await recent.svc.syncActive();
    expect(recent.zernio.listBroadcastRecipients).toHaveBeenCalledTimes(1);
    expect(recent.zernio.getBroadcast).not.toHaveBeenCalled();

    const old = build({ status: "completed", launchedAt: new Date(NOW.getTime() - 73 * 3_600_000) });
    await old.svc.syncActive();
    expect(old.zernio.listBroadcastRecipients).not.toHaveBeenCalled();
  });
});
