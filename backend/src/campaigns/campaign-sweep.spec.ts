import { CampaignSendService } from "./campaign-send.service";
import { makeFakePrisma } from "../channels/test-prisma";
import { RecipientTrackerService } from "./tracking/recipient-tracker.service";
import { CampaignReplyAttributor } from "./tracking/reply-attributor.service";

/** SP-12 Task 1 fix round 1: sweep counters, paging, scheduled tail, cron guard and ordering. */

const NOW = new Date("2026-11-09T12:00:00.000Z");
const H = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const phone = (i: number) => `+9627900${String(i).padStart(5, "0")}`;

const campaign = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  name: id,
  status: "running",
  zernioBroadcastId: `b-${id}`,
  recipientTracking: true,
  recipientSyncSkip: 0,
  recipientsSyncedAt: null,
  launchedAt: ago(H),
  scheduledAt: null,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  replied: 0,
  ...over,
});

const rows = (campaignId: string, n: number, status = "queued") =>
  Array.from({ length: n }, (_, i) => ({
    id: `${campaignId}-r${String(i).padStart(5, "0")}`,
    workspaceId: "ws1",
    campaignId,
    contactId: null,
    channelId: "chA",
    phone: phone(i),
    contactName: null,
    status,
    messageId: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    repliedAt: null,
    failureCode: null,
    failureReason: null,
    createdAt: ago(H),
    updatedAt: ago(H),
  }));

const zr = (i: number, status = "delivered") => ({
  id: `z${i}`,
  contactId: null,
  channelId: null,
  platformIdentifier: phone(i).slice(1),
  contactName: null,
  status,
  messageId: `wamid.${i}`,
  error: null,
  errorCode: null,
  errorExplanation: null,
  errorTraceId: null,
  sentAt: ago(30 * 60_000).toISOString(),
  deliveredAt: ago(29 * 60_000).toISOString(),
  readAt: null,
});

/** A Zernio that pages a list of `total` delivered recipients and reports pagination as told. */
function pagedZernio(total: number, pagination: "none" | "full" = "none") {
  return jest.fn(async (_b: string, { skip, limit }: { skip: number; limit: number }) => {
    const recipients = Array.from({ length: Math.max(0, Math.min(limit, total - skip)) }, (_, k) => zr(skip + k));
    return {
      recipients,
      pagination:
        pagination === "full"
          ? { total, limit, skip, hasMore: skip + recipients.length < total }
          : // What the client returns when Zernio sends no pagination block.
            { total: null, limit, skip, hasMore: null },
      summary: {},
    };
  });
}

function build(seed: Parameters<typeof makeFakePrisma>[0]) {
  const prisma = makeFakePrisma(seed);
  const zernio = {
    getBroadcast: jest.fn().mockResolvedValue({ status: "sending", recipientCount: 250, sent: 240, delivered: 200, read: 120, failed: 3 }),
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

describe("sweep counters (I1)", () => {
  it("counters are not zeroed before the first full pass", async () => {
    process.env.RECIPIENT_SYNC_MAX_PAGES = "1";
    const { prisma, zernio, svc } = build({ campaign: [campaign("c1")], campaignRecipient: rows("c1", 250) });
    zernio.listBroadcastRecipients.mockImplementation(pagedZernio(250, "full"));
    await svc.syncActive();
    const c = prisma.db.campaign[0];
    expect(c.recipientsSyncedAt).toBeNull();
    // Zernio's aggregate counters still apply; the 100 delivered rows never lower them.
    expect(c).toMatchObject({ sent: 240, delivered: 200, read: 120, failed: 3 });
    expect(svc.refresh).toBeDefined();
    const refreshed = await svc.refresh("ws1", "c1");
    expect(refreshed).toMatchObject({ sent: 240, delivered: 200 });
  });

  it("a paging response without hasMore still pages through 250 rows", async () => {
    const { prisma, zernio, svc } = build({ campaign: [campaign("c1")], campaignRecipient: rows("c1", 250) });
    zernio.listBroadcastRecipients.mockImplementation(pagedZernio(250, "none"));
    await svc.syncActive();
    expect(zernio.listBroadcastRecipients.mock.calls.map((c: any[]) => c[1].skip)).toEqual([0, 100, 200]);
    expect(prisma.db.campaignRecipient.every((r: { status: string }) => r.status === "delivered")).toBe(true);
    const c = prisma.db.campaign[0];
    expect(c.recipientSyncSkip).toBe(0);
    expect(c.recipientsSyncedAt).toEqual(NOW);
    // After the first full pass the counters come from rows.
    expect(c).toMatchObject({ sent: 250, delivered: 250, read: 0, failed: 0 });
  });

  it("stops when skip reaches the reported total even if hasMore is missing", async () => {
    const { zernio, svc, prisma } = build({ campaign: [campaign("c1")], campaignRecipient: rows("c1", 200) });
    const inner = pagedZernio(200, "none");
    zernio.listBroadcastRecipients.mockImplementation(async (b: string, o: { skip: number; limit: number }) => {
      const res = await inner(b, o);
      return { ...res, pagination: { ...res.pagination, total: 200 } };
    });
    await svc.syncActive();
    expect(zernio.listBroadcastRecipients).toHaveBeenCalledTimes(2);
    expect(prisma.db.campaign[0].recipientsSyncedAt).toEqual(NOW);
  });

  it("recount runs after a partial tick", async () => {
    process.env.RECIPIENT_SYNC_MAX_PAGES = "1";
    // Second pass: the first full pass already happened, so counters come from rows.
    const { prisma, zernio, svc } = build({
      campaign: [campaign("c1", { recipientsSyncedAt: ago(H), sent: 0, delivered: 0 })],
      campaignRecipient: rows("c1", 250),
    });
    zernio.listBroadcastRecipients.mockImplementation(pagedZernio(250, "full"));
    await svc.syncActive();
    const c = prisma.db.campaign[0];
    expect(c.recipientSyncSkip).toBe(100);
    expect(c).toMatchObject({ sent: 100, delivered: 100, read: 0 });
  });
});

describe("scheduled tail (I2)", () => {
  it("a campaign scheduled more than 72h ahead is swept for 72h after its scheduled send", async () => {
    const { zernio, svc } = build({
      campaign: [campaign("c1", { status: "completed", launchedAt: ago(100 * H), scheduledAt: ago(H) })],
      campaignRecipient: rows("c1", 1),
    });
    zernio.listBroadcastRecipients.mockImplementation(pagedZernio(1, "full"));
    await svc.syncActive();
    expect(zernio.listBroadcastRecipients).toHaveBeenCalledTimes(1);

    const old = build({
      campaign: [campaign("c1", { status: "completed", launchedAt: ago(200 * H), scheduledAt: ago(73 * H) })],
      campaignRecipient: rows("c1", 1),
    });
    await old.svc.syncActive();
    expect(old.zernio.listBroadcastRecipients).not.toHaveBeenCalled();
  });
});

describe("cron ordering, guard and budget (I3)", () => {
  it("status sync runs for every active campaign before any sweep", async () => {
    const { zernio, svc } = build({
      campaign: [campaign("a"), campaign("u", { recipientTracking: false }), campaign("b")],
      campaignRecipient: [...rows("a", 1), ...rows("b", 1)],
    });
    zernio.listBroadcastRecipients.mockImplementation(pagedZernio(1, "full"));
    await svc.syncActive();
    expect(zernio.getBroadcast).toHaveBeenCalledTimes(3);
    const lastStatus = Math.max(...zernio.getBroadcast.mock.invocationCallOrder);
    const firstSweep = Math.min(...zernio.listBroadcastRecipients.mock.invocationCallOrder);
    expect(lastStatus).toBeLessThan(firstSweep);
  });

  it("an overlapping tick is skipped while one is running", async () => {
    const { zernio, svc } = build({ campaign: [campaign("a")], campaignRecipient: rows("a", 1) });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    zernio.listBroadcastRecipients.mockImplementation(async (b: string, o: { skip: number; limit: number }) => {
      await gate;
      return pagedZernio(1, "full")(b, o);
    });
    const first = svc.syncActive();
    await new Promise((r) => setImmediate(r));
    await svc.syncActive(); // returns at once
    release();
    await first;
    expect(zernio.getBroadcast).toHaveBeenCalledTimes(1);
    expect(zernio.listBroadcastRecipients).toHaveBeenCalledTimes(1);
    // The guard is released: a later tick runs again.
    await svc.syncActive();
    expect(zernio.getBroadcast).toHaveBeenCalledTimes(2);
  });

  it("RECIPIENT_SYNC_MAX_PAGES is a global budget shared round-robin across campaigns", async () => {
    process.env.RECIPIENT_SYNC_MAX_PAGES = "5";
    process.env.ZERNIO_RECIPIENT_PAGE = "10";
    const { prisma, zernio, svc } = build({
      campaign: [campaign("big"), campaign("small")],
      campaignRecipient: [...rows("big", 1000), ...rows("small", 15)],
    });
    const big = pagedZernio(1000, "full");
    const small = pagedZernio(15, "full");
    zernio.listBroadcastRecipients.mockImplementation((b: string, o: { skip: number; limit: number }) =>
      b === "b-big" ? big(b, o) : small(b, o),
    );
    await svc.syncActive();
    expect(zernio.listBroadcastRecipients.mock.calls.map((c: any[]) => `${c[0]}@${c[1].skip}`)).toEqual([
      "b-big@0",
      "b-small@0",
      "b-big@10",
      "b-small@10",
      "b-big@20",
    ]);
    const by = Object.fromEntries(prisma.db.campaign.map((c: any) => [c.id, c]));
    expect(by.small).toMatchObject({ recipientSyncSkip: 0, recipientsSyncedAt: NOW });
    expect(by.big).toMatchObject({ recipientSyncSkip: 30, recipientsSyncedAt: null });
  });

  it("a failing campaign does not stop the others, and keeps its offset", async () => {
    const { prisma, zernio, svc } = build({
      campaign: [campaign("bad", { recipientSyncSkip: 40 }), campaign("ok")],
      campaignRecipient: rows("ok", 1),
    });
    const ok = pagedZernio(1, "full");
    zernio.listBroadcastRecipients.mockImplementation((b: string, o: { skip: number; limit: number }) =>
      b === "b-bad" ? Promise.reject(new Error("timeout")) : ok(b, o),
    );
    await svc.syncActive();
    const by = Object.fromEntries(prisma.db.campaign.map((c: any) => [c.id, c]));
    expect(by.bad.recipientSyncSkip).toBe(40);
    expect(by.ok.recipientsSyncedAt).toEqual(NOW);
  });
});

describe("fix round 2", () => {
  it("R1: with a budget of 2 and 3 campaigns, all three are swept across two ticks", async () => {
    process.env.RECIPIENT_SYNC_MAX_PAGES = "2";
    const { zernio, svc } = build({
      campaign: [campaign("a"), campaign("b"), campaign("c")],
      campaignRecipient: [...rows("a", 1), ...rows("b", 1), ...rows("c", 1)],
    });
    zernio.listBroadcastRecipients.mockImplementation(pagedZernio(1, "full"));
    await svc.syncActive();
    jest.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));
    await svc.syncActive();
    const swept = new Set(zernio.listBroadcastRecipients.mock.calls.map((c: any[]) => c[0]));
    expect([...swept].sort()).toEqual(["b-a", "b-b", "b-c"]);
    expect(zernio.listBroadcastRecipients).toHaveBeenCalledTimes(4);
  });

  it("R1: tail campaigns whose pass completed are swept at most hourly and do not eat the budget", async () => {
    process.env.RECIPIENT_SYNC_MAX_PAGES = "1";
    const { zernio, svc } = build({
      campaign: [
        campaign("t1", { status: "completed", recipientsSyncedAt: ago(10 * 60_000) }),
        campaign("t2", { status: "completed", recipientsSyncedAt: ago(20 * 60_000) }),
        campaign("live", { recipientsSyncedAt: ago(5 * 60_000) }),
      ],
      campaignRecipient: [...rows("t1", 1), ...rows("t2", 1), ...rows("live", 1)],
    });
    zernio.listBroadcastRecipients.mockImplementation(pagedZernio(1, "full"));
    await svc.syncActive();
    // The tail campaigns synced < 1 h ago are not swept; the live one gets the only page.
    expect(zernio.listBroadcastRecipients.mock.calls.map((c: any[]) => c[0])).toEqual(["b-live"]);

    // An hour later the tail campaigns are due again (oldest-synced first).
    jest.setSystemTime(new Date(NOW.getTime() + 61 * 60_000));
    zernio.listBroadcastRecipients.mockClear();
    await svc.syncActive();
    expect(zernio.listBroadcastRecipients.mock.calls.map((c: any[]) => c[0])).toEqual(["b-t2"]);
  });

  it("R2: an explicit hasMore:true is trusted even on a short page", async () => {
    const { prisma, zernio, svc } = build({ campaign: [campaign("c1")], campaignRecipient: rows("c1", 100) });
    zernio.listBroadcastRecipients.mockImplementation(async (_b: string, { skip }: { skip: number }) =>
      skip === 0
        ? { recipients: Array.from({ length: 95 }, (_, k) => zr(k)), pagination: { total: 100, limit: 100, skip: 0, hasMore: true }, summary: {} }
        : { recipients: Array.from({ length: 5 }, (_, k) => zr(95 + k)), pagination: { total: 100, limit: 100, skip, hasMore: false }, summary: {} },
    );
    await svc.syncActive();
    expect(zernio.listBroadcastRecipients.mock.calls.map((c: any[]) => c[1].skip)).toEqual([0, 95]);
    expect(prisma.db.campaign[0].recipientsSyncedAt).toEqual(NOW);
    expect(prisma.db.campaignRecipient.every((r: { status: string }) => r.status === "delivered")).toBe(true);
  });

  it("R3: a pass that covered fewer rows than Campaign.recipients does not end the first pass", async () => {
    // Zernio silently caps the page at 50 and sends no pagination block.
    const { prisma, zernio, svc } = build({ campaign: [campaign("c1", { recipients: 250 })], campaignRecipient: rows("c1", 250) });
    zernio.listBroadcastRecipients.mockImplementation(async (_b: string, { skip, limit }: { skip: number; limit: number }) => ({
      recipients: Array.from({ length: 50 }, (_, k) => zr(skip + k)),
      pagination: { total: null, limit, skip, hasMore: null },
      summary: {},
    }));
    await svc.syncActive();
    const c = prisma.db.campaign[0];
    expect(c.recipientsSyncedAt).toBeNull(); // Zernio's counters stay in use
    expect(c.recipientSyncSkip).toBe(0); // the pass restarts
    expect(c).toMatchObject({ sent: 240, delivered: 200, read: 120, failed: 3 });
  });

  it("R4: a reply marked while a recount is in flight is not lost", async () => {
    const { prisma, svc } = build({
      campaign: [campaign("c1", { recipientsSyncedAt: ago(H), replied: 0 })],
      campaignRecipient: rows("c1", 2, "delivered").map((r) => ({ ...r, sentAt: ago(H) })),
    });
    const tracker = new RecipientTrackerService(prisma);
    const attributor = new CampaignReplyAttributor(prisma, tracker);
    const realGroupBy = prisma.campaignRecipient.groupBy.getMockImplementation();
    let raced = false;
    prisma.campaignRecipient.groupBy.mockImplementation((a: unknown) => {
      const read = realGroupBy!(a);
      return {
        then: async (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
          try {
            const v = await read; // the recount has read its counts…
            if (!raced) {
              raced = true; // …then a reply lands before it writes
              const res = await attributor.onInbound({
                workspaceId: "ws1",
                channelId: "chA",
                contactId: null,
                phone: phone(0),
                text: "yes",
                inboundMessageId: "m1",
                at: NOW,
              });
              expect(res).not.toBeNull();
            }
            return ok(v);
          } catch (e) {
            return bad(e);
          }
        },
      };
    });
    await tracker.recountCampaign("c1");
    expect(prisma.db.campaignRecipient[0].status).toBe("replied");
    expect(prisma.db.campaign[0].replied).toBe(1);
    void svc;
  });
});
