import { CampaignSendService } from "./campaign-send.service";

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
    Array.from({ length: n }, (_, i) => ({ name: `C${i}`, phone: `9627900${String(i).padStart(5, "0")}`, lifecycle: "lead" }));

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
      integration: { findFirst: jest.fn().mockResolvedValue({ pageId: "acc1" }) },
      contact: { findMany: jest.fn().mockResolvedValue([...contacts(3), { name: "X", phone: null, lifecycle: "lead" }]) },
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
        select: { name: true, phone: true, lifecycle: true },
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
      expect(prisma.campaign.findMany).toHaveBeenCalledWith({
        where: { zernioBroadcastId: { not: null }, status: { in: ["scheduled", "running"] } },
        select: { id: true, workspaceId: true, zernioBroadcastId: true },
      });
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
