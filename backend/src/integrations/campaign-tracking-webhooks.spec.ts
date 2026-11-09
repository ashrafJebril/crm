import { ZernioService } from "./zernio.service";
import { WhatsAppService } from "./whatsapp.service";
import { makeFakePrisma } from "../channels/test-prisma";
import { InboundSinkService } from "../channels/inbound-sink.service";
import { CampaignReplyAttributor } from "../campaigns/tracking/reply-attributor.service";
import { RecipientTrackerService } from "../campaigns/tracking/recipient-tracker.service";

/**
 * SP-12 Review Focus 2 and 4 through the real webhook handlers: Zernio
 * `handleEvent` and Meta `handleWebhook` over the in-memory Prisma, with the
 * real tracker and attributor. No HTTP is made (the Zernio client is a stub).
 */

const NOW = new Date("2026-11-09T12:00:00.000Z");
const t = (min: number) => new Date(NOW.getTime() + min * 60_000);
const H = 3_600_000;

const channel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "zernio",
  externalId: `acc-${id}`,
  displayName: `Number ${id}`,
  status: "active",
  isDefault: true,
  integrationId: null,
  secretsEnc: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

const campaign = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  name: id,
  status: "running",
  recipientTracking: true,
  launchedAt: t(-30),
  scheduledAt: null,
  zernioBroadcastId: `b-${id}`,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  replied: 0,
  ...over,
});

let seq = 0;
const recipient = (over: Record<string, unknown> = {}) => ({
  id: `rcp${String(++seq).padStart(4, "0")}`,
  workspaceId: "ws1",
  campaignId: "c1",
  contactId: null,
  channelId: "A",
  phone: "+962790000001",
  contactName: "Sara",
  status: "sent",
  messageId: null,
  sentAt: t(-29),
  deliveredAt: null,
  readAt: null,
  repliedAt: null,
  replyText: null,
  buttonPayload: null,
  replyMessageId: null,
  failureCode: null,
  failureReason: null,
  createdAt: t(-30),
  updatedAt: t(-30),
  ...over,
});

function zernio(prisma: ReturnType<typeof makeFakePrisma>, attributor?: CampaignReplyAttributor) {
  const automation = { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) };
  const svc = new ZernioService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    {} as never,
    automation as never,
    { enabled: false } as never,
    { isConfigured: () => false } as never,
    undefined,
    undefined,
    undefined,
    new RecipientTrackerService(prisma),
    attributor,
  );
  return { svc, automation };
}

function meta(prisma: ReturnType<typeof makeFakePrisma>, attributor?: CampaignReplyAttributor) {
  return new WhatsAppService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    { onInboundMessage: jest.fn(async () => {}) } as never,
    { isConfigured: () => false } as never,
    undefined,
    undefined,
    new RecipientTrackerService(prisma),
    attributor,
  );
}

const zStatus = (type: string, ids: { id?: string; platformMessageId?: string }, accountId = "acc-A", extra: Record<string, unknown> = {}) => ({
  event: type,
  message: { ...ids, platform: "whatsapp", direction: "outgoing", ...extra },
  conversation: { id: "zc-1", participantId: "962790000001" },
  account: { accountId, platform: "whatsapp" },
});

const metaStatuses = (phoneNumberId: string, statuses: Array<Record<string, unknown>>): any => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, statuses } }] }],
});

const metaMessage = (phoneNumberId: string, msg: Record<string, unknown>): any => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "waba",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: phoneNumberId },
            contacts: [{ wa_id: "962790000001", profile: { name: "Sara" } }],
            messages: [{ from: "962790000001", timestamp: String(Math.floor(NOW.getTime() / 1000)), ...msg }],
          },
        },
      ],
    },
  ],
});

const pick = (r: Record<string, unknown>) => ({
  status: r.status,
  sentAt: r.sentAt,
  deliveredAt: r.deliveredAt,
  readAt: r.readAt,
  messageId: r.messageId,
});

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
});
afterEach(() => jest.useRealTimers());

describe("SP-12 status webhooks", () => {
  it("delivery webhook out of order (read before delivered) keeps both timestamps", async () => {
    // Zernio: the row is matched on message.platformMessageId.
    const prisma = makeFakePrisma({ channel: [channel("A")], campaign: [campaign("c1")], campaignRecipient: [recipient({ messageId: "wamid.Z1" })] });
    const { svc } = zernio(prisma);
    const ids = { id: "zm-unknown", platformMessageId: "wamid.Z1" };
    jest.setSystemTime(t(5)); // t2
    expect(await svc.handleEvent(zStatus("message.read", ids))).toEqual({ ok: true });
    jest.setSystemTime(t(2)); // t1, arriving late
    expect(await svc.handleEvent(zStatus("message.delivered", ids))).toEqual({ ok: true });
    const row = prisma.db.campaignRecipient[0];
    expect(row).toMatchObject({ status: "read", readAt: t(5), deliveredAt: t(2), sentAt: t(-29) });
    const snapshot = pick(row);
    jest.setSystemTime(t(9));
    await svc.handleEvent(zStatus("message.read", ids));
    await svc.handleEvent(zStatus("message.delivered", ids));
    expect(pick(prisma.db.campaignRecipient[0])).toEqual(snapshot);

    // Meta: the same through the statuses loop, with Meta's own timestamps.
    const mp = makeFakePrisma({
      channel: [channel("M", { provider: "meta", externalId: "pn-M" })],
      campaign: [campaign("c1")],
      campaignRecipient: [recipient({ channelId: "M", messageId: "wamid.M1" })],
    });
    const wa = meta(mp);
    const sec = (d: Date) => String(Math.floor(d.getTime() / 1000));
    await wa.handleWebhook(metaStatuses("pn-M", [{ id: "wamid.M1", status: "read", timestamp: sec(t(5)), recipient_id: "962790000001" }]));
    await wa.handleWebhook(metaStatuses("pn-M", [{ id: "wamid.M1", status: "delivered", timestamp: sec(t(2)), recipient_id: "962790000001" }]));
    expect(mp.db.campaignRecipient[0]).toMatchObject({ status: "read", readAt: t(5), deliveredAt: t(2) });
    const metaSnap = pick(mp.db.campaignRecipient[0]);
    await wa.handleWebhook(
      metaStatuses("pn-M", [
        { id: "wamid.M1", status: "read", timestamp: sec(t(8)), recipient_id: "962790000001" },
        { id: "wamid.M1", status: "delivered", timestamp: sec(t(7)), recipient_id: "962790000001" },
      ]),
    );
    expect(pick(mp.db.campaignRecipient[0])).toEqual(metaSnap);
  });

  it("Meta failed status stores the namespaced code and a one-line reason", async () => {
    const mp = makeFakePrisma({
      channel: [channel("M", { provider: "meta", externalId: "pn-M" })],
      campaign: [campaign("c1")],
      campaignRecipient: [recipient({ channelId: "M", messageId: "wamid.F" })],
    });
    await meta(mp).handleWebhook(
      metaStatuses("pn-M", [
        {
          id: "wamid.F",
          status: "failed",
          timestamp: String(Math.floor(NOW.getTime() / 1000)),
          recipient_id: "962790000001",
          errors: [{ code: 131026, title: "Message undeliverable", error_data: { details: "Unable to deliver.\nTry later" } }],
        },
      ]),
    );
    expect(mp.db.campaignRecipient[0]).toMatchObject({ status: "failed", failureCode: "meta:131026", failureReason: "Unable to deliver. Try later" });
  });

  it("unknown messageId is ignored: no write, no throw, and the webhook returns {ok:true}", async () => {
    const prisma = makeFakePrisma({ channel: [channel("A")], campaign: [campaign("c1")], campaignRecipient: [recipient({ messageId: "wamid.Z1" })] });
    const { svc } = zernio(prisma);
    for (const type of ["message.delivered", "message.read", "message.failed"]) {
      expect(await svc.handleEvent(zStatus(type, { id: "zm-x", platformMessageId: "wamid.other" }))).toEqual({ ok: true });
    }
    expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
    expect(prisma.db.campaignRecipient[0]).toMatchObject({ status: "sent", deliveredAt: null, readAt: null });
  });

  it("status webhook is scoped to the channel's workspace", async () => {
    const prisma = makeFakePrisma({
      channel: [channel("A"), channel("B", { workspaceId: "ws2", externalId: "acc-B" })],
      campaign: [campaign("c1")],
      campaignRecipient: [recipient({ messageId: "wamid.SHARED" })],
    });
    const { svc } = zernio(prisma);
    await svc.handleEvent(zStatus("message.read", { platformMessageId: "wamid.SHARED" }, "acc-B"));
    expect(prisma.db.campaignRecipient[0]).toMatchObject({ status: "sent", readAt: null });
    await svc.handleEvent(zStatus("message.read", { platformMessageId: "wamid.SHARED" }, "acc-A"));
    expect(prisma.db.campaignRecipient[0]).toMatchObject({ status: "read", readAt: NOW });
  });

  it("message.sent stamps a queued recipient by phone only when no Message matched", async () => {
    const prisma = makeFakePrisma({
      channel: [channel("A")],
      campaign: [campaign("c1"), campaign("old", { status: "completed", launchedAt: t(-25 * 60) })],
      campaignRecipient: [
        recipient({ campaignId: "c1", status: "queued", sentAt: null }),
        recipient({ campaignId: "old", status: "queued", sentAt: null }),
      ],
    });
    const { svc } = zernio(prisma);
    const sentAt = t(-1).toISOString();
    await svc.handleEvent(zStatus("message.sent", { id: "zm-1", platformMessageId: "wamid.1" }, "acc-A", { sentAt, text: "Eid offer" }));
    const [c1, old] = prisma.db.campaignRecipient;
    expect(c1).toMatchObject({ status: "sent", messageId: "zm-1", sentAt: t(-1) });
    expect(old).toMatchObject({ status: "queued", messageId: null });
    // R12 unchanged: the broadcast message is still stored in the thread.
    expect(prisma.db.message).toHaveLength(1);
    expect(prisma.db.message[0]).toMatchObject({ from: "human", metaMessageId: "zm-1" });

    // Later status events now match the stamped row on either id.
    await svc.handleEvent(zStatus("message.delivered", { id: "zm-1", platformMessageId: "wamid.1" }));
    expect(prisma.db.campaignRecipient[0]).toMatchObject({ status: "delivered", deliveredAt: NOW });

    // Stamped once: a second message.sent to the same phone stamps nothing.
    await svc.handleEvent(zStatus("message.sent", { id: "zm-2" }, "acc-A", { sentAt }));
    expect(prisma.db.campaignRecipient[0].messageId).toBe("zm-1");
    expect(prisma.db.campaignRecipient[1]).toMatchObject({ status: "queued", messageId: null });
  });

  it("an app-composed message (a Message row matched) does not stamp", async () => {
    const prisma = makeFakePrisma({
      channel: [channel("A")],
      campaign: [campaign("c1")],
      campaignRecipient: [recipient({ status: "queued", sentAt: null })],
      message: [{ id: "m-app", workspaceId: "ws1", conversationId: "cv", metaMessageId: "zm-app", deliveryStatus: null }],
    });
    const { svc } = zernio(prisma);
    await svc.handleEvent(zStatus("message.sent", { id: "zm-app" }, "acc-A", { sentAt: NOW.toISOString() }));
    expect(prisma.db.message[0].deliveryStatus).toBe("sent");
    expect(prisma.db.campaignRecipient[0]).toMatchObject({ status: "queued", messageId: null });
  });
});

describe("SP-12 replies through the inbound paths", () => {
  const seed = (channelOver: Record<string, unknown> = {}) =>
    makeFakePrisma({
      channel: [channel("A", channelOver)],
      campaign: [campaign("c1")],
      campaignRecipient: [recipient({ channelId: "A", contactId: "imported" })],
    });

  it("button replies store payload and text (Meta button and interactive)", async () => {
    const mp = seed({ provider: "meta", externalId: "pn-A" });
    const wa = meta(mp);
    await wa.handleWebhook(metaMessage("pn-A", { id: "wamid.in1", type: "button", button: { text: "Yes, book me", payload: "BOOK" } }));
    expect(mp.db.campaignRecipient[0]).toMatchObject({ status: "replied", replyText: "Yes, book me", buttonPayload: "BOOK", repliedAt: NOW });
    expect(mp.db.campaignRecipient[0].replyMessageId).toBe(mp.db.message[0].id);
    // extractBody renders the button text instead of "[button message]".
    expect(mp.db.message[0].body).toBe("Yes, book me");
    expect(mp.db.campaign[0].replied).toBe(1);

    const mp2 = seed({ provider: "meta", externalId: "pn-A" });
    await meta(mp2).handleWebhook(
      metaMessage("pn-A", { id: "wamid.in2", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes_1", title: "Yes" } } }),
    );
    expect(mp2.db.campaignRecipient[0]).toMatchObject({ replyText: "Yes", buttonPayload: "yes_1" });
    expect(mp2.db.message[0].body).toBe("Yes");
  });

  it("button replies store payload and text (Zernio metadata when present, null otherwise)", async () => {
    const zIn = (id: string, extra: Record<string, unknown>) => ({
      event: "message.received",
      message: { id, platform: "whatsapp", direction: "incoming", sender: { id: "962790000001", name: "Sara" }, ...extra },
      conversation: { id: "zc-1", participantId: "962790000001", participantName: "Sara" },
      account: { accountId: "acc-A", platform: "whatsapp" },
    });
    const p1 = seed();
    await zernio(p1).svc.handleEvent(zIn("zin-1", { text: "Yes", metadata: { buttonPayload: "YES" } }));
    expect(p1.db.campaignRecipient[0]).toMatchObject({ status: "replied", replyText: "Yes", buttonPayload: "YES" });

    const p2 = seed();
    await zernio(p2).svc.handleEvent(zIn("zin-2", { text: "How much?" }));
    expect(p2.db.campaignRecipient[0]).toMatchObject({ status: "replied", replyText: "How much?", buttonPayload: null });
    expect(p2.db.campaignRecipient[0].replyMessageId).toBe(p2.db.message[0].id);

    // An outbound echo is never a reply.
    const p3 = seed();
    await zernio(p3).svc.handleEvent({ ...zIn("zin-3", { text: "our promo" }), message: { id: "zin-3", direction: "outgoing", text: "our promo" } });
    expect(p3.db.campaignRecipient[0].status).toBe("sent");
  });

  it("InboundSinkService attributes a non-duplicate record once", async () => {
    const prisma = makeFakePrisma({
      channel: [channel("T", { kind: "telegram", provider: "telegram" })],
      campaign: [campaign("c1")],
      campaignRecipient: [recipient({ channelId: "T", phone: "+962790000001" })],
    });
    const attributor = new CampaignReplyAttributor(prisma, new RecipientTrackerService(prisma));
    const spy = jest.spyOn(attributor, "onInbound");
    const sink = new InboundSinkService(prisma, { emitToWorkspace: jest.fn() } as never, { onInboundMessage: jest.fn(async () => {}) } as never, undefined, attributor);
    const input = {
      workspaceId: "ws1",
      channel: prisma.db.channel[0],
      externalSource: "telegram",
      externalId: "tg-1",
      phone: "+962790000001",
      text: "hello",
      providerMessageId: "tg:T:1",
      at: NOW,
    };
    await sink.record(input);
    await sink.record(input); // duplicate: no second attribution
    expect(spy).toHaveBeenCalledTimes(1);
    expect(prisma.db.campaignRecipient[0]).toMatchObject({ status: "replied", replyText: "hello" });
  });

  it("attributor never throws into inbound: a DB error is logged and the message is still stored", async () => {
    const zp = seed();
    zp.campaign.findMany.mockImplementation(() => Promise.reject(new Error("db down")));
    const res = await zernio(zp).svc.handleEvent({
      event: "message.received",
      message: { id: "zin-9", platform: "whatsapp", direction: "incoming", text: "hi", sender: { id: "962790000001" } },
      conversation: { id: "zc-1", participantId: "962790000001" },
      account: { accountId: "acc-A", platform: "whatsapp" },
    });
    expect(res).toEqual({ ok: true });
    expect(zp.db.message).toHaveLength(1);

    const mp = seed({ provider: "meta", externalId: "pn-A" });
    const broken = new CampaignReplyAttributor(mp, new RecipientTrackerService(mp));
    mp.campaignRecipient.findMany.mockImplementation(() => Promise.reject(new Error("db down")));
    await expect(meta(mp, broken).handleWebhook(metaMessage("pn-A", { id: "wamid.in9", type: "text", text: { body: "hi" } }))).resolves.toMatchObject({ ok: true });
    expect(mp.db.message).toHaveLength(1);
    expect(mp.db.campaignRecipient[0].status).toBe("sent");
  });

  it("a reply more than 72h after the send is not attributed through the webhook either", async () => {
    const zp = makeFakePrisma({
      channel: [channel("A")],
      campaign: [campaign("c1", { launchedAt: t(-80 * 60) })],
      campaignRecipient: [recipient({ sentAt: new Date(NOW.getTime() - 72 * H - 1000) })],
    });
    await zernio(zp).svc.handleEvent({
      event: "message.received",
      message: { id: "zin-late", platform: "whatsapp", direction: "incoming", text: "late", sender: { id: "962790000001" } },
      conversation: { id: "zc-1", participantId: "962790000001" },
      account: { accountId: "acc-A", platform: "whatsapp" },
    });
    expect(zp.db.campaignRecipient[0].status).toBe("sent");
  });
});
