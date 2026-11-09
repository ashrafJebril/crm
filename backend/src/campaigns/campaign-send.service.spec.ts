import { CampaignSendService } from "./campaign-send.service";
import { makeFakePrisma } from "../channels/test-prisma";
import { RecipientTrackerService } from "./tracking/recipient-tracker.service";
import { HttpException } from "@nestjs/common";
import { channel, contact, ME, world, WS, zernioCopy } from "./sending/launch-test-world";

/* eslint-disable @typescript-eslint/no-explicit-any */

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

  describe("launch (SP-13: validate, claim, kick, 202)", () => {
    const BODY = "Hi {{1}}, {{2}} off";
    const legacyVars = [{ field: "name" as const }, { field: "custom" as const, customValue: "20%" }];
    const people = (n: number) => Array.from({ length: n }, (_, i) => contact(`c${String(i).padStart(5, "0")}`, `C${i}`, `+9627900${String(i).padStart(5, "0")}`));
    const keyOf = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        const r = (e as HttpException).getResponse() as Record<string, unknown> | string;
        return { status: (e as HttpException).getStatus(), ...(typeof r === "string" ? { message: r } : r) };
      }
      return null;
    };

    it("claims the draft as launching, answers before any Zernio call, and the job sends it", async () => {
      const w = world({ body: BODY, contacts: people(3) });
      const res = await w.send.launch(WS, "camp", { mode: "now", variables: legacyVars }, { userId: ME });
      expect(res).toMatchObject({ status: "launching", launchStage: "planning", launchedById: ME, launchAttempts: 0 });
      // Legacy body variables were converted and stored; the body is kept for history.
      expect(res.varMap).toEqual({ "1": { source: "field", key: "name" }, "2": { source: "static", value: "20%" } });
      expect(res.variableMapping).toEqual(legacyVars);
      expect(w.zernio.bulkCreateContacts).not.toHaveBeenCalled();
      await w.runner.idle();
      expect(w.zernio.createWhatsAppBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "acc-A", template: { name: "svc", language: "en" }, variables: [{ field: "name" }, { field: "custom", customValue: "20%" }] }),
      );
      expect(w.camp()).toMatchObject({ status: "running", recipients: 3, skipped: 0, zernioBroadcastId: "zb1", lastError: null });
    });

    it("schedules for a future time", async () => {
      const w = world({ contacts: people(2) });
      const when = new Date(Date.now() + 3_600_000).toISOString();
      await w.launch({ mode: "schedule", scheduledAt: when });
      expect(w.zernio.scheduleBroadcast).toHaveBeenCalledWith("zb1", when);
      expect(w.zernio.sendBroadcast).not.toHaveBeenCalled();
      expect(w.camp()).toMatchObject({ status: "scheduled" });
      expect(w.camp().scheduledAt).toEqual(new Date(when));
    });

    it("refuses with keyed errors, in order, and claims nothing", async () => {
      const cases: Array<[string, Parameters<typeof world>[0], Record<string, unknown>, Record<string, unknown>?]> = [
        ["already launched", { campaign: { status: "running", zernioBroadcastId: "b0" } }, { status: 409, message: "campaigns.already_launched" }],
        ["schedule in the past", {}, { status: 400, message: "campaigns.schedule_invalid" }, { mode: "schedule", scheduledAt: "2020-01-01T00:00:00.000Z" }],
        ["schedule missing", {}, { status: 400, message: "campaigns.schedule_invalid" }, { mode: "schedule" }],
        ["template pending", { template: { status: "pending" } }, { status: 400, message: "campaigns.template_not_approved" }],
        ["no template", { campaign: { templateId: null } }, { status: 400, message: "campaigns.template_not_approved" }],
        ["text header variable", { template: { headerType: "text", headerContent: "Hi {{1}}" } }, { status: 400, message: "campaigns.template_unsupported" }],
        ["dynamic URL button", { template: { buttons: JSON.stringify([{ type: "URL", text: "Go", url: "https://x.test/{{1}}" }]) } }, { status: 400, message: "campaigns.template_unsupported" }],
        ["foreign sender", { senders: ["X"], channels: [channel("A"), channel("X", { workspaceId: "ws2" })] }, { status: 400, message: "channels.sender_invalid" }],
        ["missing slot", { body: "Hi {{1}}" }, { status: 400, message: "campaigns.var_map_invalid", slot: "1", reason: "missing_slot" }],
        ["company", { body: "Hi {{1}}" }, { status: 400, message: "campaigns.var_map_invalid", reason: "bad_key" }, { mode: "now", variables: [{ field: "company" }] }],
        ["unknown custom key", { body: "Hi {{1}}", varMap: { "1": { source: "custom", key: "nope" } } }, { status: 400, message: "campaigns.var_map_invalid", reason: "unknown_custom_field" }],
      ];
      for (const [name, opts, expected, input] of cases) {
        const w = world({ contacts: people(1), ...opts });
        const before = w.camp().status;
        expect({ name, e: await keyOf(w.send.launch(WS, "camp", (input ?? { mode: "now" }) as never, { userId: ME })) }).toEqual({
          name,
          e: expect.objectContaining(expected),
        });
        await w.runner.idle();
        expect({ name, status: w.camp().status }).toEqual({ name, status: before });
        expect(w.zernio.bulkCreateContacts).not.toHaveBeenCalled();
      }
    });

    it("refuses while the workspace is locked for an unpaid subscription", async () => {
      const w = world({ contacts: people(1) });
      w.isLocked.mockResolvedValue(true);
      await expect(w.send.launch(WS, "camp", { mode: "now" })).rejects.toThrow(/payment/i);
      expect(w.camp().status).toBe("draft");
    });

    it("not connected: no Zernio profile, or no number, is the keyed 409", async () => {
      const noProfile = world({ contacts: people(1) });
      noProfile.prisma.db.workspace[0].zernioProfileId = null;
      expect(await keyOf(noProfile.send.launch(WS, "camp", { mode: "now" }))).toMatchObject({ status: 409, message: "campaigns.whatsapp_not_connected", code: "WHATSAPP_NOT_CONNECTED" });
      const noNumber = world({ contacts: people(1), channels: [] });
      expect(await keyOf(noNumber.send.launch(WS, "camp", { mode: "now" }))).toMatchObject({ status: 409, message: "campaigns.whatsapp_not_connected" });
    });

    it("the template must be on every sender: missing is 400, unreadable is 502", async () => {
      const w = world({ senders: ["A", "B"], contacts: people(2) });
      w.zernio.whatsappTemplates.mockImplementation(async (acc: string) => (acc === "acc-B" ? [] : [zernioCopy("Hello")]));
      expect(await keyOf(w.send.launch(WS, "camp", { mode: "now" }))).toMatchObject({ status: 400, message: "campaigns.template_missing_on_number", channelIds: ["B"] });
      w.zernio.whatsappTemplates.mockImplementation(async (acc: string) => {
        if (acc === "acc-B") throw new Error("Zernio down");
        return [zernioCopy("Hello")];
      });
      expect(await keyOf(w.send.launch(WS, "camp", { mode: "now" }))).toMatchObject({ status: 502, message: "campaigns.template_check_failed", channelIds: ["B"] });
      expect(w.camp().status).toBe("draft");
    });

    it("launch writes recipients in chunks of 1000 before calling Zernio", async () => {
      const contacts = [
        ...people(2500),
        contact("o1", "Out1", "962791000001", { marketingOptOut: true }),
        contact("o2", "Out2", "962791000002", { lifecycle: "churned" }),
        contact("o3", "Out3", null, { marketingOptOut: true }),
        contact("z1", "NoPhone1", null),
        contact("z2", "NoPhone2", "0790000000"),
      ];
      const w = world({ contacts });
      await w.launch();
      const calls = w.prisma.campaignRecipient.createMany.mock.calls.map((c: any[]) => c[0]);
      for (const c of calls) expect(c.skipDuplicates).toBe(true);
      expect(Math.max(...calls.map((c: any) => c.data.length))).toBe(1000);
      expect(calls.reduce((n: number, c: any) => n + c.data.length, 0)).toBe(2505);
      expect(w.rows().filter((r: any) => r.status === "queued")).toHaveLength(2500);
      expect(
        w.rows()
          .filter((r: any) => r.status === "skipped")
          .map((r: any) => [r.contactId, r.failureCode, r.phone])
          .sort(),
      ).toEqual([
        ["o1", "skip:opted_out", "+962791000001"],
        ["o2", "skip:opted_out", "+962791000002"],
        ["o3", "skip:opted_out", null],
        ["z1", "skip:no_phone", null],
        ["z2", "skip:no_phone", null],
      ]);
      const lastWrite = Math.max(...w.prisma.campaignRecipient.createMany.mock.invocationCallOrder);
      expect(lastWrite).toBeLessThan(w.zernio.bulkCreateContacts.mock.invocationCallOrder[0]);
      expect(w.camp()).toMatchObject({ recipients: 2500, skipped: 5, status: "running", recipientTracking: true });
    });

    it("launch with 100k recipients never inserts more than 1000 rows per call", async () => {
      const w = world({ contacts: [] });
      const N = 100_000;
      w.prisma.contact.findMany = jest.fn(async (a: any) => {
        const from = a.where?.id?.gt ? Number(String(a.where.id.gt).slice(1)) + 1 : 0;
        const n = Math.max(0, Math.min(a.take, N - from));
        return Array.from({ length: n }, (_, k) => ({ ...contact(`k${String(from + k).padStart(6, "0")}`, `K${from + k}`, `+9627${String(from + k).padStart(8, "0")}`) }));
      });
      const sizes: number[] = [];
      w.prisma.campaignRecipient.createMany = jest.fn(async (a: any) => {
        sizes.push(a.data.length);
        return { count: a.data.length };
      });
      await w.launch();
      expect(sizes).toHaveLength(100);
      expect(Math.max(...sizes)).toBe(1000);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(N);
      // No per-recipient round-trips: one cleanup delete, then only the chunked createMany.
      expect(w.prisma.campaignRecipient.deleteMany).toHaveBeenCalledTimes(1);
    });

    it("launch failure leaves recipients queued and campaign failed", async () => {
      const w = world({ contacts: people(3) });
      w.zernio.sendBroadcast.mockRejectedValue(new HttpException("Template parameter count mismatch", 400));
      await w.launch();
      expect(w.camp()).toMatchObject({ status: "failed", lastError: "campaigns.launch_failed" });
      expect(w.partitions()[0].lastError).toBe("Template parameter count mismatch");
      expect(w.rows()).toHaveLength(3);
      expect(w.rows().every((r: any) => r.status === "queued")).toBe(true);
    });

    it("a relaunched draft always clears leftover rows first", async () => {
      const w = world({ contacts: people(2) });
      w.prisma.db.campaignRecipient.push({ id: "old", workspaceId: WS, campaignId: "camp", phone: "+962799999999", status: "queued" });
      await w.launch();
      expect(w.rows().map((r: any) => r.phone)).not.toContain("+962799999999");
      expect(w.rows()).toHaveLength(2);
    });

    it("records the sending channel on every row", async () => {
      const w = world({ senders: ["B"], contacts: [...people(3), contact("x", "Out", "962791000009", { marketingOptOut: true })] });
      await w.launch();
      expect(w.zernio.createWhatsAppBroadcast.mock.calls[0][0].accountId).toBe("acc-B");
      for (const r of w.rows()) expect(r.channelId).toBe("B");
    });

    it("opted-out contact is skipped by campaign send (with a skipped row)", async () => {
      const w = world({
        contacts: [contact("lina", "Lina", "962790000001", { marketingOptOut: true }), contact("omar", "Omar", "962790000002")],
      });
      await w.launch();
      expect(w.zernio.addBroadcastRecipients).toHaveBeenCalledWith("zb1", ["+962790000002"]);
      expect(w.rows().find((r: any) => r.contactId === "lina")).toMatchObject({ status: "skipped", failureCode: "skip:opted_out" });
      expect(w.rows().find((r: any) => r.contactId === "omar")).toMatchObject({ status: "queued" });
    });

    it("an opted-out number on an earlier page never blocks a reachable contact with the same number later", async () => {
      const w = world({ contacts: [contact("a1", "Out", "962790000001", { marketingOptOut: true }), contact("a2", "In", "962790000001")] });
      w.runner.pageSize = 1;
      await w.launch();
      expect(w.rows().find((r: any) => r.contactId === "a2")).toMatchObject({ status: "queued", phone: "+962790000001" });
      expect(w.rows().find((r: any) => r.contactId === "a1")).toMatchObject({ status: "skipped", phone: null });
      expect(w.zernio.addBroadcastRecipients).toHaveBeenCalledWith("zb1", ["+962790000001"]);
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
      await expect(svc.cancel("ws1", "camp1")).rejects.toMatchObject({ status: 400, response: { message: "campaigns.not_cancellable" } });
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
    process.env.ZERNIO_RECIPIENT_PAGE = "3";
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
      .mockResolvedValueOnce({ recipients: page1, pagination: { total: 7, limit: 3, skip: 0, hasMore: true }, summary: {} })
      .mockResolvedValueOnce({ recipients: page2, pagination: { total: 7, limit: 3, skip: 3, hasMore: false }, summary: {} });

    await svc.syncActive();
    expect(zernio.listBroadcastRecipients).toHaveBeenLastCalledWith("b1", { skip: 0, limit: 3 });
    const camp = prisma.db.campaign[0];
    expect(camp.recipientSyncSkip).toBe(3);
    expect(camp.recipientsSyncedAt).toBeNull();
    // Before the first full pass Zernio's aggregate counters still apply (fix I1).
    expect(camp.status).toBe("running");
    expect(camp.sent).toBe(9);

    await svc.syncActive();
    expect(zernio.listBroadcastRecipients).toHaveBeenLastCalledWith("b1", { skip: 3, limit: 3 });
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
