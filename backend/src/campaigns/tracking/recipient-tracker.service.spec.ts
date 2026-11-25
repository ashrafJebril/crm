import { makeFakePrisma } from "../../channels/test-prisma";
import { RecipientTrackerService } from "./recipient-tracker.service";

const H = 3_600_000;
const NOW = new Date("2026-11-09T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const campaign = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  name: id,
  status: "running",
  recipientTracking: true,
  launchedAt: ago(H),
  scheduledAt: null,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  replied: 0,
  ...over,
});

let seq = 0;
const row = (over: Record<string, unknown> = {}) => ({
  id: `r${String(++seq).padStart(4, "0")}`,
  workspaceId: "ws1",
  campaignId: "c1",
  contactId: null,
  channelId: "chA",
  phone: "+962790000001",
  contactName: "Lina",
  status: "queued",
  messageId: null,
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  repliedAt: null,
  replyText: null,
  buttonPayload: null,
  replyMessageId: null,
  failureCode: null,
  failureReason: null,
  createdAt: ago(H),
  updatedAt: ago(H),
  ...over,
});

describe("RecipientTrackerService", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  });
  afterEach(() => jest.useRealTimers());

  describe("applyProviderStatus", () => {
    it("updates rows whose messageId is one of the event's ids, monotonically", async () => {
      const prisma = makeFakePrisma({ campaign: [campaign("c1")], campaignRecipient: [row({ messageId: "wamid.1", status: "sent", sentAt: ago(H) })] });
      const t = new RecipientTrackerService(prisma);
      expect(await t.applyProviderStatus({ workspaceId: "ws1", ids: ["zid-1", "wamid.1"], kind: "read", at: ago(10) })).toBe(1);
      expect(await t.applyProviderStatus({ workspaceId: "ws1", ids: ["zid-1", "wamid.1"], kind: "delivered", at: ago(20) })).toBe(1);
      expect(prisma.db.campaignRecipient[0]).toMatchObject({ status: "read", readAt: ago(10), deliveredAt: ago(20) });
      // replay
      expect(await t.applyProviderStatus({ workspaceId: "ws1", ids: ["wamid.1"], kind: "read", at: ago(1) })).toBe(0);
      expect(prisma.db.campaignRecipient[0].readAt).toEqual(ago(10));
    });

    it("unknown messageId is ignored (no write, no throw)", async () => {
      const prisma = makeFakePrisma({ campaignRecipient: [row({ messageId: "wamid.1" })] });
      const t = new RecipientTrackerService(prisma);
      expect(await t.applyProviderStatus({ workspaceId: "ws1", ids: ["nope", null, undefined, ""], kind: "delivered", at: NOW })).toBe(0);
      expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
      expect(await t.applyProviderStatus({ workspaceId: "ws1", ids: [], kind: "delivered", at: NOW })).toBe(0);
      expect(prisma.campaignRecipient.findMany).toHaveBeenCalledTimes(1);
    });

    it("is scoped to the given workspace", async () => {
      const prisma = makeFakePrisma({ campaignRecipient: [row({ messageId: "wamid.1", workspaceId: "wsA" })] });
      const t = new RecipientTrackerService(prisma);
      expect(await t.applyProviderStatus({ workspaceId: "wsB", ids: ["wamid.1"], kind: "read", at: NOW })).toBe(0);
      expect(prisma.db.campaignRecipient[0].status).toBe("queued");
    });

    it("compare-and-set: a lost race is re-read and merged once more", async () => {
      const prisma = makeFakePrisma({ campaignRecipient: [row({ messageId: "wamid.1", status: "sent", sentAt: ago(H) })] });
      const t = new RecipientTrackerService(prisma);
      const real = prisma.campaignRecipient.updateMany.getMockImplementation();
      let first = true;
      prisma.campaignRecipient.updateMany.mockImplementation((a: unknown) => {
        if (first) {
          first = false;
          // A concurrent writer stamps delivered between our read and our write.
          Object.assign(prisma.db.campaignRecipient[0], { status: "delivered", deliveredAt: ago(30), updatedAt: ago(1) });
        }
        return real!(a);
      });
      expect(await t.applyProviderStatus({ workspaceId: "ws1", ids: ["wamid.1"], kind: "read", at: ago(5) })).toBe(1);
      expect(prisma.db.campaignRecipient[0]).toMatchObject({ status: "read", deliveredAt: ago(30), readAt: ago(5) });
      expect(prisma.campaignRecipient.updateMany).toHaveBeenCalledTimes(2);
    });

    it("never throws: a DB error is logged and 0 returned", async () => {
      const prisma = makeFakePrisma();
      prisma.campaignRecipient.findMany.mockImplementation(() => Promise.reject(new Error("db down")));
      const t = new RecipientTrackerService(prisma);
      await expect(t.applyProviderStatus({ workspaceId: "ws1", ids: ["x"], kind: "read", at: NOW })).resolves.toBe(0);
    });
  });

  describe("stampByPhone (ruling 2)", () => {
    const input = { workspaceId: "ws1", channelId: "chA", phone: "962790000001", messageId: "zm-1", at: ago(1000) };

    it("stamps exactly one queued row of a sending campaign", async () => {
      const prisma = makeFakePrisma({
        campaign: [campaign("c1"), campaign("old", { status: "completed", launchedAt: ago(25 * H) })],
        campaignRecipient: [row({ campaignId: "c1" }), row({ campaignId: "old" })],
      });
      const t = new RecipientTrackerService(prisma);
      expect(await t.stampByPhone(input)).toBe(true);
      const [c1, old] = prisma.db.campaignRecipient;
      expect(c1).toMatchObject({ status: "sent", messageId: "zm-1", sentAt: ago(1000) });
      expect(old).toMatchObject({ status: "queued", messageId: null });
      // A second event for the same phone finds no queued row: nothing more.
      expect(await t.stampByPhone({ ...input, messageId: "zm-2" })).toBe(false);
      expect(c1.messageId).toBe("zm-1");
    });

    it("does nothing when two sending campaigns both have a queued row for the phone", async () => {
      const prisma = makeFakePrisma({
        campaign: [campaign("c1"), campaign("c2")],
        campaignRecipient: [row({ campaignId: "c1" }), row({ campaignId: "c2" })],
      });
      const t = new RecipientTrackerService(prisma);
      expect(await t.stampByPhone(input)).toBe(false);
      expect(prisma.db.campaignRecipient.every((r: { status: string }) => r.status === "queued")).toBe(true);
    });

    it("ignores other channels, untracked or draft campaigns and missing data", async () => {
      const prisma = makeFakePrisma({
        campaign: [campaign("c1"), campaign("d", { status: "draft", launchedAt: null })],
        campaignRecipient: [row({ campaignId: "c1", channelId: "chB" }), row({ campaignId: "d" })],
      });
      const t = new RecipientTrackerService(prisma);
      expect(await t.stampByPhone(input)).toBe(false);
      expect(await t.stampByPhone({ ...input, phone: null })).toBe(false);
      expect(await t.stampByPhone({ ...input, messageId: null })).toBe(false);
    });
  });

  describe("recountCampaign", () => {
    it("recomputes the counters from rows (ruling 5)", async () => {
      const prisma = makeFakePrisma({
        campaign: [campaign("c1")],
        campaignRecipient: [
          row({ status: "queued" }),
          row({ status: "sent" }),
          row({ status: "delivered" }),
          row({ status: "read" }),
          row({ status: "read" }),
          row({ status: "replied" }),
          row({ status: "failed" }),
          row({ status: "skipped" }),
          row({ status: "read", campaignId: "other" }),
        ],
      });
      await new RecipientTrackerService(prisma).recountCampaign("c1");
      expect(prisma.db.campaign[0]).toMatchObject({ sent: 5, delivered: 4, read: 3, replied: 1, failed: 1 });
    });
  });
});
