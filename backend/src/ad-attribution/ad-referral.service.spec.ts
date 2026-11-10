import { Logger } from "@nestjs/common";
import { ZernioService } from "../integrations/zernio.service";
import { WhatsAppService } from "../integrations/whatsapp.service";
import { makeFakePrisma } from "../channels/test-prisma";
import { AdReferralService, upsertAdSourceFromSync } from "./ad-referral.service";
import type { FetchCreative } from "./creative-rehost";
import { parseMetaReferral } from "./referral";

/**
 * SP-15 Review Focus 1 and 2 through the real webhook handlers: Zernio
 * `handleEvent` and Meta `handleWebhook` over the in-memory Prisma, with the
 * real AdReferralService. No HTTP: the creative fetcher is a stub, and an
 * unexpected fetch fails the test.
 */

const NOW = new Date("2026-11-15T09:00:00.000Z");
const sec = (d: Date) => String(Math.floor(d.getTime() / 1000));
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const refA = {
  source_url: "https://fb.me/ad-a",
  source_id: "120210000000001",
  source_type: "ad",
  headline: "Spring sale",
  body: "Up to 40% off this week",
  media_type: "image",
  image_url: "https://scontent.xx.fbcdn.net/v/a.jpg?oh=1",
  ctwa_clid: "clid-A",
  welcome_message: { text: "Hi! How can we help?" },
};
const refB = {
  source_url: "https://fb.me/ad-b",
  source_id: "120210000000002",
  source_type: "ad",
  headline: "Winter sale",
  body: "New arrivals",
  media_type: "video",
  thumbnail_url: "https://video.xx.fbcdn.net/v/b-thumb.jpg",
  video_url: "https://video.xx.fbcdn.net/v/b.mp4",
  ctwa_clid: "clid-B",
};

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

function world(seed: Parameters<typeof makeFakePrisma>[0] = {}) {
  const prisma = makeFakePrisma({
    channel: [channel("Z"), channel("M", { provider: "meta", externalId: "pn-M" })],
    ...seed,
  });
  const fetchCreative = jest.fn<ReturnType<FetchCreative>, Parameters<FetchCreative>>(async () => ({ buffer: PNG, mimeType: "image/png" }));
  let n = 0;
  const media = {
    ingestBuffer: jest.fn(async (input: { workspaceId: string; mimeType: string }) => {
      const row = { id: `media_${++n}`, workspaceId: input.workspaceId, mimeType: input.mimeType };
      prisma.db.media = [...(prisma.db.media ?? []), row];
      return row;
    }),
  };
  const ads = new AdReferralService(prisma, media as never, fetchCreative);
  const zernio = new ZernioService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    {} as never,
    { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) } as never,
    { enabled: false } as never,
    { isConfigured: () => false } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ads,
  );
  const meta = new WhatsAppService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    { onInboundMessage: jest.fn(async () => {}) } as never,
    { isConfigured: () => false } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ads,
  );
  return { prisma, ads, zernio, meta, fetchCreative, media };
}
type World = ReturnType<typeof world>;

/** Zernio inbound; `where` puts the attribution at the payload root or under `message`. */
const zEvent = (
  id: string,
  referral: Record<string, unknown> | null,
  where: "root" | "message" = "root",
  over: { type?: string; direction?: string } = {},
) => {
  const metadata = referral ? { referral, ad: { adId: referral.source_id, name: referral.headline, synced: false } } : undefined;
  return {
    event: over.type ?? "message.received",
    ...(where === "root" && metadata ? { metadata } : {}),
    message: {
      id,
      platform: "whatsapp",
      direction: over.direction ?? "incoming",
      text: "Hello",
      sender: { id: "962790000001", name: "Sara" },
      ...(where === "message" && metadata ? { metadata } : {}),
    },
    conversation: { id: "zc-1", participantId: "962790000001", participantName: "Sara" },
    account: { accountId: "acc-Z", platform: "whatsapp" },
  };
};

const mEvent = (id: string, referral: Record<string, unknown> | null, when: Date = NOW, phoneNumberId = "pn-M"): any => ({
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
            messages: [
              { from: "962790000001", id, timestamp: sec(when), type: "text", text: { body: "Hello" }, ...(referral ? { referral } : {}) },
            ],
          },
        },
      ],
    },
  ],
});

interface Provider {
  name: string;
  /** Sends inbound message `n` (1-based) with an optional referral at minute `n`. */
  send(w: World, n: number, referral: Record<string, unknown> | null): Promise<unknown>;
}

/** Zernio stamps our receive time: the clock is fixed at minute `n` (Date only is faked). */
async function atClock<T>(n: number, run: () => Promise<T>): Promise<T> {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask"] });
  jest.setSystemTime(at(n));
  try {
    return await run();
  } finally {
    jest.useRealTimers();
  }
}

const PROVIDERS: Provider[] = [
  {
    name: "zernio (root metadata)",
    send: (w, n, r) => atClock(n, () => w.zernio.handleEvent(zEvent(`zm-${n}`, r, "root"))),
  },
  {
    name: "zernio (message.metadata)",
    send: (w, n, r) => atClock(n, () => w.zernio.handleEvent(zEvent(`zm-${n}`, r, "message"))),
  },
  {
    name: "meta",
    send: (w, n, r) => w.meta.handleWebhook(mEvent(`wamid.${n}`, r, at(n))),
  },
];

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe("SP-15 referral capture", () => {
  describe.each(PROVIDERS)("$name", (p) => {
    it("referral captured only on first inbound", async () => {
      const w = world();

      // 1. First message with referral A: AdSource A, one first touch, conversation attributed.
      await p.send(w, 1, refA);
      await w.ads.drain();
      expect(w.prisma.db.adSource).toHaveLength(1);
      const a = w.prisma.db.adSource[0];
      expect(a).toMatchObject({
        workspaceId: "ws1",
        sourceId: refA.source_id,
        sourceType: "ad",
        headline: refA.headline,
        body: refA.body,
        mediaType: "image",
        sourceUrl: refA.source_url,
        mediaUrl: refA.image_url,
        welcomeText: "Hi! How can we help?",
        adName: null,
        namesFrom: null,
      });
      expect(w.prisma.db.adReferral).toHaveLength(1);
      const m1 = w.prisma.db.message[0];
      expect(w.prisma.db.adReferral[0]).toMatchObject({
        workspaceId: "ws1",
        adSourceId: a.id,
        messageId: m1.id,
        firstTouch: true,
        ctwaClid: "clid-A",
        provider: p.name.startsWith("zernio") ? "zernio" : "meta",
      });
      const conv = w.prisma.db.conversation[0];
      expect(conv.adSourceId).toBe(a.id);
      // The fixed time of message 1, for both providers (not the stored touch's own value).
      expect(conv.adReferredAt).toEqual(at(1));
      expect(w.prisma.db.adReferral[0].referredAt).toEqual(at(1));
      expect(a).toMatchObject({ firstReferredAt: at(1), lastReferredAt: at(1) });

      // 2. A message without a referral changes nothing.
      const snapshot = JSON.stringify({ s: w.prisma.db.adSource, r: w.prisma.db.adReferral, c: conv.adSourceId, t: conv.adReferredAt });
      await p.send(w, 2, null);
      expect(w.prisma.db.message).toHaveLength(2);
      expect(JSON.stringify({ s: w.prisma.db.adSource, r: w.prisma.db.adReferral, c: conv.adSourceId, t: conv.adReferredAt })).toBe(snapshot);

      // 3. A later referral B: a new ad and a touch, but the first touch stays A.
      await p.send(w, 3, refB);
      await w.ads.drain();
      expect(w.prisma.db.adSource).toHaveLength(2);
      const b = w.prisma.db.adSource.find((s: any) => s.sourceId === refB.source_id);
      expect(b).toMatchObject({ headline: "Winter sale", mediaType: "video", mediaUrl: refB.thumbnail_url });
      expect(w.prisma.db.adReferral).toHaveLength(2);
      expect(w.prisma.db.adReferral[1]).toMatchObject({ adSourceId: b.id, firstTouch: false, ctwaClid: "clid-B" });
      expect(conv.adSourceId).toBe(a.id);
      expect(conv.adReferredAt).toEqual(at(1));
      expect(w.prisma.db.adReferral[1].referredAt).toEqual(at(3));

      // 4. A redelivery of message 1 (same wamid / Zernio id) is a no-op.
      await p.send(w, 1, refA);
      expect(w.prisma.db.message).toHaveLength(3);
      expect(w.prisma.db.adReferral.filter((r: any) => r.messageId === m1.id)).toHaveLength(1);
      expect(w.prisma.db.adReferral).toHaveLength(2);
    });
  });

  it("referral captured only on first inbound: a Zernio outbound echo captures nothing", async () => {
    const w = world();
    await w.zernio.handleEvent(zEvent("echo-1", refA, "root", { type: "message.sent", direction: "outgoing" }));
    await w.zernio.handleEvent(zEvent("echo-2", refA, "message", { type: "message.received", direction: "outgoing" }));
    expect(w.prisma.db.message).toHaveLength(2);
    expect(w.prisma.db.message.every((m: any) => m.from === "human")).toBe(true);
    // M4: an unmatched message.sent without a direction is stored (pre-existing
    // behaviour) but is never a customer click.
    const noDirection = zEvent("echo-3", refA, "root", { type: "message.sent" });
    delete (noDirection.message as any).direction;
    await w.zernio.handleEvent(noDirection);
    expect(w.prisma.db.message).toHaveLength(3);
    expect(w.prisma.db.adSource).toHaveLength(0);
    expect(w.prisma.db.adReferral).toHaveLength(0);
    expect(w.prisma.db.conversation[0].adSourceId).toBeNull();
    expect(w.fetchCreative).not.toHaveBeenCalled();
  });

  describe("I1: one click is one touch", () => {
    it("conversation.started (no message id) then message.received with the same metadata: one touch", async () => {
      const w = world();
      const metadata = { referral: refA, ad: { adId: refA.source_id, name: refA.headline, synced: false } };
      const started = { ...zEvent("ignored", null), event: "conversation.started", metadata };
      delete (started.message as any).id;
      await atClock(1, () => w.zernio.handleEvent(started));
      await atClock(2, () => w.zernio.handleEvent({ ...zEvent("zm-2", null), metadata }));
      await w.ads.drain();
      expect(w.prisma.db.message).toHaveLength(2);
      expect(w.prisma.db.adReferral).toHaveLength(1);
      expect(w.prisma.db.adReferral[0]).toMatchObject({ firstTouch: true, ctwaClid: "clid-A", referredAt: at(1) });
      expect(w.prisma.db.adSource[0]).toMatchObject({ firstReferredAt: at(1), lastReferredAt: at(1) });
    });

    it("conversation-level root metadata repeated on later plain messages adds no touch", async () => {
      const w = world();
      // A referral without ctwa_clid (Status placement), repeated on every webhook.
      const { ctwa_clid: _c, ...noClid } = refA;
      const metadata = { referral: noClid, ad: { adId: refA.source_id, synced: false } };
      await atClock(1, () => w.zernio.handleEvent({ ...zEvent("zm-1", null), metadata }));
      await atClock(2, () => w.zernio.handleEvent({ ...zEvent("zm-2", null), metadata }));
      await atClock(3, () => w.zernio.handleEvent({ ...zEvent("zm-3", null), metadata }));
      await w.ads.drain();
      expect(w.prisma.db.message).toHaveLength(3);
      expect(w.prisma.db.adReferral).toHaveLength(1);
      expect(w.prisma.db.adSource[0]).toMatchObject({ firstReferredAt: at(1), lastReferredAt: at(1) });
    });

    it("an ad-only metadata.ad counts on conversation.started, never on message.received", async () => {
      const w = world();
      const metadata = { ad: { adId: "5550001", name: "x", synced: false } };
      await atClock(1, () => w.zernio.handleEvent({ ...zEvent("zm-1", null), metadata }));
      expect(w.prisma.db.adReferral).toHaveLength(0);
      await atClock(2, () => w.zernio.handleEvent({ ...zEvent("zm-2", null), event: "conversation.started", metadata }));
      expect(w.prisma.db.adReferral).toHaveLength(1);
      expect(w.prisma.db.adSource[0]).toMatchObject({ sourceId: "5550001", sourceType: "ad", headline: null });
      // Repeated on a later conversation.started: still one touch.
      await atClock(3, () => w.zernio.handleEvent({ ...zEvent("zm-3", null), event: "conversation.started", metadata }));
      expect(w.prisma.db.adReferral).toHaveLength(1);
    });

    it("a new click on the same ad (another ctwa_clid) is a new touch", async () => {
      const w = world();
      await w.meta.handleWebhook(mEvent("wamid.1", refA, at(1)));
      await w.meta.handleWebhook(mEvent("wamid.2", refA, at(2)));
      expect(w.prisma.db.adReferral).toHaveLength(1);
      await w.meta.handleWebhook(mEvent("wamid.3", { ...refA, ctwa_clid: "clid-A2" }, at(3)));
      expect(w.prisma.db.adReferral).toHaveLength(2);
      expect(w.prisma.db.adSource[0]).toMatchObject({ firstReferredAt: at(1), lastReferredAt: at(3) });
    });
  });

  it("M1: the touch insert and the first-touch update run in one transaction", async () => {
    const w = world();
    let inTx = false;
    const calls: Array<[string, boolean]> = [];
    const realTx = w.prisma.$transaction;
    w.prisma.$transaction = jest.fn(async (arg: any) => {
      inTx = true;
      try {
        return await realTx(arg);
      } finally {
        inTx = false;
      }
    });
    for (const [model, op] of [["adReferral", "createMany"], ["adReferral", "updateMany"]] as const) {
      const orig = w.prisma[model][op];
      w.prisma[model][op] = jest.fn((a: any) => {
        calls.push([`${model}.${op}`, inTx]);
        return orig(a);
      });
    }
    const origConv = w.prisma.conversation.updateMany;
    w.prisma.conversation.updateMany = jest.fn((a: any) => {
      if (a?.where && "adSourceId" in a.where) calls.push(["conversation.updateMany(firstTouch)", inTx]);
      return origConv(a);
    });
    await w.meta.handleWebhook(mEvent("wamid.1", refA, at(1)));
    expect(w.prisma.db.adReferral[0].firstTouch).toBe(true);
    expect(calls).toEqual([
      ["adReferral.createMany", true],
      ["conversation.updateMany(firstTouch)", true],
      ["adReferral.updateMany", true],
    ]);
  });

  it("M2: concurrent touches never move first/lastReferredAt backwards", async () => {
    const w = world({
      adSource: [{ id: "s1", workspaceId: "ws1", sourceType: "ad", sourceId: refA.source_id, firstReferredAt: at(5), lastReferredAt: at(5) }],
      conversation: [
        { id: "cv1", workspaceId: "ws1", contactId: "c1", channel: "whatsapp", adSourceId: null },
        { id: "cv2", workspaceId: "ws1", contactId: "c2", channel: "whatsapp", adSourceId: null },
        { id: "cv3", workspaceId: "ws1", contactId: "c3", channel: "whatsapp", adSourceId: null },
      ],
      message: [
        { id: "m1", workspaceId: "ws1", conversationId: "cv1" },
        { id: "m2", workspaceId: "ws1", conversationId: "cv2" },
        { id: "m3", workspaceId: "ws1", conversationId: "cv3" },
      ],
    });
    const base = { workspaceId: "ws1", channelId: "M", provider: "meta" as const };
    const ref = (clid: string) => parseMetaReferral({ ...refA, ctwa_clid: clid })!;
    await Promise.all([
      w.ads.capture({ ...base, conversationId: "cv1", contactId: "c1", messageId: "m1", referral: ref("x1"), at: at(9) }),
      w.ads.capture({ ...base, conversationId: "cv2", contactId: "c2", messageId: "m2", referral: ref("x2"), at: at(7) }),
      w.ads.capture({ ...base, conversationId: "cv3", contactId: "c3", messageId: "m3", referral: ref("x3"), at: at(2) }),
    ]);
    expect(w.prisma.db.adReferral).toHaveLength(3);
    expect(w.prisma.db.adSource[0]).toMatchObject({ firstReferredAt: at(2), lastReferredAt: at(9) });
  });

  it("a Zernio referral on a non-WhatsApp account is ignored (ruling 4)", async () => {
    const w = world({ channel: [channel("IG", { kind: "instagram", externalId: "acc-IG" })] });
    const evt = zEvent("ig-1", refA);
    (evt.message as any).platform = "instagram";
    (evt.account as any) = { accountId: "acc-IG", platform: "instagram" };
    await w.zernio.handleEvent(evt);
    expect(w.prisma.db.message).toHaveLength(1);
    expect(w.prisma.db.adReferral).toHaveLength(0);
  });

  it("redelivered referral is a no-op (capture called twice for one message)", async () => {
    const w = world();
    await w.meta.handleWebhook(mEvent("wamid.1", refA));
    const ctx = {
      workspaceId: "ws1",
      channelId: "M",
      conversationId: w.prisma.db.conversation[0].id,
      contactId: w.prisma.db.contact[0].id,
      messageId: w.prisma.db.message[0].id,
      at: NOW,
    };
    expect(await w.ads.captureMeta(refA, ctx)).toBeNull();
    expect(w.prisma.db.adReferral).toHaveLength(1);
  });

  it("absent referral fields stay null", async () => {
    const w = world();
    const warn = Logger.prototype.warn as jest.Mock;
    warn.mockClear();
    // A WhatsApp Status placement: no ctwa_clid, no image_url, no welcome_message.
    await w.meta.handleWebhook(mEvent("wamid.s1", { source_id: "777", source_type: "ad", media_type: "image", headline: "Status ad" }));
    await w.ads.drain();
    expect(w.prisma.db.adSource[0]).toMatchObject({
      sourceId: "777",
      headline: "Status ad",
      body: null,
      mediaUrl: null,
      mediaId: null,
      welcomeText: null,
      sourceUrl: null,
      adName: null,
      adAccountId: null,
    });
    expect(w.prisma.db.adReferral[0].ctwaClid).toBeNull();
    expect(w.fetchCreative).not.toHaveBeenCalled();

    // No source_id: nothing stored, a key logged without the payload.
    await w.meta.handleWebhook(mEvent("wamid.s2", { ...refA, source_id: undefined }, at(5)));
    expect(w.prisma.db.message).toHaveLength(2);
    expect(w.prisma.db.adSource).toHaveLength(1);
    expect(w.prisma.db.adReferral).toHaveLength(1);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("referral_missing_source_id"))).toBe(true);
    for (const l of lines) {
      expect(l).not.toContain("clid-A");
      expect(l).not.toContain("fbcdn");
      expect(l).not.toContain("Spring sale");
      expect(l).not.toContain("962790000001");
    }

    // Over-long or http: values are dropped to null, never truncated.
    await w.meta.handleWebhook(
      mEvent("wamid.s3", { ...refA, source_id: "888", headline: "h".repeat(600), source_url: "http://fb.me/x", image_url: "http://scontent.fbcdn.net/a.jpg" }, at(6)),
    );
    expect(w.prisma.db.adSource.find((s: any) => s.sourceId === "888")).toMatchObject({ headline: null, sourceUrl: null, mediaUrl: null, body: refA.body });
  });

  it("zernio unsynced ad name is not stored", async () => {
    const w = world();
    // synced:false → Zernio's `name` is Meta's headline, not an ad name.
    await w.zernio.handleEvent({
      ...zEvent("z-1", null),
      metadata: { referral: refA, ad: { adId: refA.source_id, name: refA.headline, synced: false, adAccountId: "55" } },
    });
    expect(w.prisma.db.adSource[0]).toMatchObject({ adName: null, adSetName: null, campaignName: null, namesFrom: null, adAccountId: null });

    // synced:true (under message.metadata) → names and the account are stored.
    await w.zernio.handleEvent({
      ...zEvent("z-2", null),
      message: {
        ...zEvent("z-2", null).message,
        metadata: {
          referral: refB,
          ad: { adId: refB.source_id, name: "Winter / Reels", synced: true, adSetName: "Riyadh 25-34", campaignName: "Winter", adAccountId: "act_55" },
        },
      },
    });
    expect(w.prisma.db.adSource.find((s: any) => s.sourceId === refB.source_id)).toMatchObject({
      adName: "Winter / Reels",
      adSetName: "Riyadh 25-34",
      campaignName: "Winter",
      adAccountId: "act_55",
      namesFrom: "zernio",
    });
  });

  it("concurrent first referrals set one first touch", async () => {
    const w = world();
    // Two messages of one conversation already stored; their captures interleave.
    await w.meta.handleWebhook(mEvent("wamid.c1", null, at(1)));
    await w.meta.handleWebhook(mEvent("wamid.c2", null, at(2)));
    const [m1, m2] = w.prisma.db.message;
    const base = { workspaceId: "ws1", channelId: "M", conversationId: m1.conversationId, contactId: w.prisma.db.contact[0].id };
    const [r1, r2] = await Promise.all([
      w.ads.capture({ ...base, messageId: m1.id, provider: "meta", referral: parseMetaReferral(refA)!, at: at(1) }),
      w.ads.capture({ ...base, messageId: m2.id, provider: "meta", referral: parseMetaReferral(refB)!, at: at(2) }),
    ]);
    const firsts = w.prisma.db.adReferral.filter((r: any) => r.firstTouch);
    expect(firsts).toHaveLength(1);
    expect([r1?.firstTouch, r2?.firstTouch].filter(Boolean)).toHaveLength(1);
    expect(w.prisma.db.conversation[0].adSourceId).toBe(firsts[0].adSourceId);
    expect(w.prisma.db.adReferral).toHaveLength(2);
  });

  it("capture never throws into the webhook", async () => {
    for (const provider of ["zernio", "meta"] as const) {
      const w = world();
      w.prisma.adSource.findUnique = jest.fn(() => Promise.reject(Object.assign(new Error("db down"), { code: "P1001" })));
      const res =
        provider === "zernio"
          ? await w.zernio.handleEvent(zEvent("x-1", refA))
          : await w.meta.handleWebhook(mEvent("wamid.x1", refA));
      expect(res).toMatchObject({ ok: true });
      expect(w.prisma.db.message).toHaveLength(1);
      expect(w.prisma.db.adReferral).toHaveLength(0);
      expect(w.prisma.db.conversation[0].adSourceId).toBeNull();
    }
  });

  it("same ad id in two workspaces stays separate", async () => {
    const w = world({
      channel: [channel("Z"), channel("M", { provider: "meta", externalId: "pn-M" }), channel("M2", { workspaceId: "ws2", provider: "meta", externalId: "pn-M2" })],
    });
    await w.meta.handleWebhook(mEvent("wamid.w1", refA, at(1), "pn-M"));
    await w.meta.handleWebhook(mEvent("wamid.w2", refA, at(2), "pn-M2"));
    await w.ads.drain();
    const sources = w.prisma.db.adSource;
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map((s: any) => s.workspaceId))).toEqual(new Set(["ws1", "ws2"]));
    expect(sources.every((s: any) => s.sourceId === refA.source_id)).toBe(true);
    for (const r of w.prisma.db.adReferral) {
      const src = sources.find((s: any) => s.id === r.adSourceId);
      const conv = w.prisma.db.conversation.find((c: any) => c.id === r.conversationId);
      expect(src.workspaceId).toBe(r.workspaceId);
      expect(conv.workspaceId).toBe(r.workspaceId);
      expect(conv.adSourceId).toBe(src.id);
    }
    // Each workspace re-hosts its own copy of the creative.
    expect(w.media.ingestBuffer.mock.calls.map((c) => c[0].workspaceId).sort()).toEqual(["ws1", "ws2"]);
  });

  it("a later referral fills only null creative fields and moves the dates", async () => {
    const w = world();
    await w.meta.handleWebhook(mEvent("wamid.f1", { source_id: "9", source_type: "ad", headline: "First" }, at(1)));
    await w.meta.handleWebhook(mEvent("wamid.f2", { source_id: "9", source_type: "ad", headline: "Changed", body: "Body now" }, at(2)));
    await w.meta.handleWebhook(mEvent("wamid.f3", { source_id: "9", source_type: "ad" }, at(3)));
    expect(w.prisma.db.adSource).toHaveLength(1);
    expect(w.prisma.db.adSource[0]).toMatchObject({ headline: "First", body: "Body now", firstReferredAt: at(1), lastReferredAt: at(3) });
  });
});

describe("upsertAdSourceFromSync (Task 2 contract)", () => {
  it("creates a names-only row and lets the sync's names win over Zernio's", async () => {
    const prisma = makeFakePrisma({
      adSource: [
        { id: "s1", workspaceId: "ws1", sourceType: "ad", sourceId: "1", headline: "H", adName: "Zernio name", namesFrom: "zernio", adAccountId: null },
      ],
    });
    expect(await upsertAdSourceFromSync(prisma, "ws1", { sourceId: "1", adAccountId: "act_9", adName: "Meta name", adSetName: null, campaignName: "C" })).toEqual({
      id: "s1",
    });
    expect(prisma.db.adSource[0]).toMatchObject({ headline: "H", adName: "Meta name", campaignName: "C", namesFrom: "meta_sync", adAccountId: "act_9" });

    const created = await upsertAdSourceFromSync(prisma, "ws1", { sourceId: "2", adAccountId: "act_9", adName: "Spend only", adSetName: "S", campaignName: "C" });
    expect(prisma.db.adSource.find((s: any) => s.id === created?.id)).toMatchObject({
      sourceType: "ad",
      headline: null,
      mediaUrl: null,
      adName: "Spend only",
      namesFrom: "meta_sync",
      firstReferredAt: null,
    });
    expect(await upsertAdSourceFromSync(prisma, "ws1", { sourceId: "bad id!", adAccountId: null, adName: null, adSetName: null, campaignName: null })).toBeNull();
  });

  it("a Zernio referral never overwrites meta_sync names", async () => {
    const w = world({
      adSource: [{ id: "s1", workspaceId: "ws1", sourceType: "ad", sourceId: refA.source_id, adName: "Meta name", namesFrom: "meta_sync", adAccountId: "act_1" }],
    });
    await w.zernio.handleEvent({
      ...zEvent("z-9", null),
      metadata: { referral: refA, ad: { adId: refA.source_id, name: "Zernio", synced: true, adAccountId: "act_2" } },
    });
    expect(w.prisma.db.adSource[0]).toMatchObject({ adName: "Meta name", namesFrom: "meta_sync", adAccountId: "act_1", headline: refA.headline });
  });
});
