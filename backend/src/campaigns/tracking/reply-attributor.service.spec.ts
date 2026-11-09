import { makeFakePrisma } from "../../channels/test-prisma";
import { CampaignReplyAttributor } from "./reply-attributor.service";
import { RecipientTrackerService } from "./recipient-tracker.service";

const H = 3_600_000;
const T = new Date("2026-11-01T09:00:00.000Z");
const at = (ms: number) => new Date(T.getTime() + ms);

const campaign = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  name: id,
  status: "completed",
  recipientTracking: true,
  launchedAt: T,
  scheduledAt: null,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  replied: 0,
  ...over,
});

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  campaignId: "c1",
  contactId: "imported-contact",
  channelId: "chA",
  phone: "+962790000001",
  contactName: "Lina",
  status: "delivered",
  messageId: "wamid.x",
  sentAt: T,
  deliveredAt: T,
  readAt: null,
  repliedAt: null,
  replyText: null,
  buttonPayload: null,
  replyMessageId: null,
  failureCode: null,
  failureReason: null,
  createdAt: T,
  updatedAt: T,
  ...over,
});

const reply = (when: Date, over: Record<string, unknown> = {}) => ({
  workspaceId: "ws1",
  channelId: "chA",
  // A Zernio-created contact, not the imported audience contact: matching is by phone.
  contactId: "zernio-contact",
  phone: "962790000001",
  text: "Is it still on?",
  buttonPayload: null,
  inboundMessageId: "msg-in-1",
  at: when,
  ...over,
});

function build(seed: Parameters<typeof makeFakePrisma>[0]) {
  const prisma = makeFakePrisma(seed);
  const attributor = new CampaignReplyAttributor(prisma, new RecipientTrackerService(prisma));
  return { prisma, attributor };
}

describe("reply attribution window 72h", () => {
  it("sentAt T: a reply at T+72h attributes; T+72h+1s does not", async () => {
    const late = build({ campaign: [campaign("c1")], campaignRecipient: [row("r1")] });
    expect(await late.attributor.onInbound(reply(at(72 * H + 1000)))).toBeNull();
    expect(late.prisma.db.campaignRecipient[0].status).toBe("delivered");

    const edge = build({ campaign: [campaign("c1")], campaignRecipient: [row("r1")] });
    expect(await edge.attributor.onInbound(reply(at(72 * H)))).toEqual({ recipientId: "r1", campaignId: "c1" });
    expect(edge.prisma.db.campaignRecipient[0]).toMatchObject({
      status: "replied",
      repliedAt: at(72 * H),
      replyText: "Is it still on?",
      buttonPayload: null,
      replyMessageId: "msg-in-1",
    });
  });

  it("a reply on another channel does not attribute; nor one before the send", async () => {
    const { prisma, attributor } = build({ campaign: [campaign("c1")], campaignRecipient: [row("r1")] });
    expect(await attributor.onInbound(reply(at(H), { channelId: "chB" }))).toBeNull();
    expect(await attributor.onInbound(reply(at(-1000)))).toBeNull();
    expect(await attributor.onInbound(reply(at(H), { workspaceId: "ws2" }))).toBeNull();
    expect(prisma.db.campaignRecipient[0].status).toBe("delivered");
  });

  it("two campaigns to the same phone: only the later one gets the reply, and the first reply wins", async () => {
    const { prisma, attributor } = build({
      campaign: [campaign("c1"), campaign("c2", { launchedAt: at(H) })],
      campaignRecipient: [row("r1", { campaignId: "c1" }), row("r2", { campaignId: "c2", sentAt: at(H) })],
    });
    expect(await attributor.onInbound(reply(at(2 * H), { text: "first" }))).toEqual({ recipientId: "r2", campaignId: "c2" });
    expect(await attributor.onInbound(reply(at(3 * H), { text: "second", inboundMessageId: "msg-in-2" }))).toBeNull();
    const [r1, r2] = prisma.db.campaignRecipient;
    expect(r2).toMatchObject({ status: "replied", replyText: "first", replyMessageId: "msg-in-1", repliedAt: at(2 * H) });
    expect(r1).toMatchObject({ status: "delivered", repliedAt: null, replyText: null });
  });

  it("a row with sentAt null attributes through launchedAt (T-5min)", async () => {
    const { attributor, prisma } = build({
      campaign: [campaign("c1", { launchedAt: at(-5 * 60_000), status: "running" })],
      campaignRecipient: [row("r1", { sentAt: null, status: "queued", messageId: null })],
    });
    expect(await attributor.onInbound(reply(at(0)))).toEqual({ recipientId: "r1", campaignId: "c1" });
    expect(prisma.db.campaignRecipient[0].status).toBe("replied");
  });

  it("a scheduled campaign is measured from scheduledAt until sentAt is known", async () => {
    const { attributor } = build({
      campaign: [campaign("c1", { launchedAt: at(-100 * H), scheduledAt: at(-H), status: "scheduled" })],
      campaignRecipient: [row("r1", { sentAt: null, status: "queued", messageId: null })],
    });
    expect(await attributor.onInbound(reply(at(0)))).toEqual({ recipientId: "r1", campaignId: "c1" });
  });

  it("a skipped row never attributes", async () => {
    const { attributor, prisma } = build({
      campaign: [campaign("c1")],
      campaignRecipient: [row("r1", { status: "skipped", sentAt: null, messageId: null, failureCode: "skip:opted_out" })],
    });
    expect(await attributor.onInbound(reply(at(H)))).toBeNull();
    expect(prisma.db.campaignRecipient[0].status).toBe("skipped");
  });

  it("matches by contact id when the phone differs, and by phone when the contact differs", async () => {
    const byContact = build({ campaign: [campaign("c1")], campaignRecipient: [row("r1", { phone: "+962790000099" })] });
    expect(await byContact.attributor.onInbound(reply(at(H), { contactId: "imported-contact" }))).toEqual({ recipientId: "r1", campaignId: "c1" });
    const byPhone = build({ campaign: [campaign("c1")], campaignRecipient: [row("r1")] });
    expect(await byPhone.attributor.onInbound(reply(at(H), { phone: "+962 79 000 0001" }))).toEqual({ recipientId: "r1", campaignId: "c1" });
  });

  it("failed rows can be marked replied and keep their failure code", async () => {
    const { attributor, prisma } = build({
      campaign: [campaign("c1")],
      campaignRecipient: [row("r1", { status: "failed", failureCode: "meta:131026" })],
    });
    expect(await attributor.onInbound(reply(at(H)))).not.toBeNull();
    expect(prisma.db.campaignRecipient[0]).toMatchObject({ status: "replied", failureCode: "meta:131026" });
  });

  it("Campaign.replied is incremented by one per first reply, without a full recount (fix M2)", async () => {
    const { attributor, prisma } = build({
      campaign: [campaign("c1", { replied: 4, read: 7, delivered: 9, sent: 10 })],
      campaignRecipient: [row("r1"), row("r2", { phone: "+962790000002", contactId: "other", status: "read" })],
    });
    await attributor.onInbound(reply(at(H)));
    // Only `replied` moves; the sweep's recount reconciles the rest.
    expect(prisma.db.campaign[0]).toMatchObject({ replied: 5, read: 7, delivered: 9, sent: 10 });
    expect(prisma.campaignRecipient.groupBy).not.toHaveBeenCalled();
    // A second reply (first reply wins) does not increment again.
    await attributor.onInbound(reply(at(2 * H), { inboundMessageId: "msg-in-2" }));
    expect(prisma.db.campaign[0].replied).toBe(5);
  });

  it("attributor never throws into inbound: a DB error is logged and null returned", async () => {
    const { attributor, prisma } = build({ campaign: [campaign("c1")], campaignRecipient: [row("r1")] });
    prisma.campaign.findMany.mockImplementation(() => Promise.reject(new Error("db down")));
    await expect(attributor.onInbound(reply(at(H)))).resolves.toBeNull();
  });
});
