/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException } from "@nestjs/common";
import { ZernioRateLimitError } from "../../integrations/zernio.client";
import { CampaignsController } from "../campaigns.module";
import { contact, world, WS } from "./launch-test-world";

/** SP-13 final review fix wave: list canCancel (I2), status guards, recount, header copy key, shared budget (R19). */

const NOW = new Date("2026-11-09T12:00:00.000Z");
const H = 3_600_000;
const phone = (i: number) => `+9627900${String(i).padStart(5, "0")}`;
const people = (n: number) => Array.from({ length: n }, (_, i) => contact(`c${String(i).padStart(3, "0")}`, `N${i}`, phone(i)));
const keyOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const r = (e as HttpException).getResponse() as Record<string, unknown> | string;
    return { status: (e as HttpException).getStatus(), ...(typeof r === "string" ? { message: r } : r) };
  }
  return null;
};

const row = (id: string, over: Record<string, unknown>) => ({
  id,
  workspaceId: WS,
  name: id,
  status: "draft",
  audience: "All",
  channel: "Broadcast",
  segmentId: null,
  templateId: "tpl",
  zernioBroadcastId: null,
  senderChannelIds: [],
  senderChannelId: null,
  sendTransport: null,
  launchStage: null,
  recipients: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  createdAt: new Date(NOW.getTime() - Number(id.replace(/\D/g, "") || 0) * 1000),
  ...over,
});
const part = (id: string, campaignId: string, stage: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: WS,
  campaignId,
  channelId: "A",
  accountId: "acc-A",
  partitionKey: id,
  variables: {},
  transport: "broadcast",
  stage,
  zernioBroadcastId: `zb-${id}`,
  createdAt: NOW,
  ...over,
});

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  delete process.env.CAMPAIGN_MAX_PARTITIONS;
  delete process.env.CAMPAIGN_DIRECT_MAX;
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.CAMPAIGN_MAX_PARTITIONS;
  delete process.env.CAMPAIGN_DIRECT_MAX;
});

describe("I2: GET /campaigns carries canCancel (the cancellable() rule) and launch progress, without an N+1", () => {
  function seeded() {
    const w = world();
    const ctrl = new CampaignsController(w.prisma, w.send, w.preview, w.media as never);
    w.prisma.db.campaign.push(
      row("c1", { status: "running", sendTransport: "direct" }), // runner done: nothing to cancel
      row("c2", { status: "scheduled", sendTransport: "direct", launchStage: "sending" }), // waiting direct
      row("c3", { status: "failed", sendTransport: "broadcast", zernioBroadcastId: "zb-p3" }), // live partition
      row("c4", { status: "cancelled", sendTransport: "broadcast", zernioBroadcastId: "zb-p4" }), // stop unconfirmed
      row("c5", { status: "failed", sendTransport: "broadcast", zernioBroadcastId: "zb-p5" }), // all stopped
      row("c6", { status: "running", sendTransport: "broadcast", zernioBroadcastId: "zb-p6" }),
      row("c7", { status: "running", sendTransport: null, zernioBroadcastId: "zb-legacy" }), // legacy
      row("c8", { status: "completed", sendTransport: null, zernioBroadcastId: "zb-legacy2" }),
      row("c9", { status: "launching", sendTransport: "broadcast", launchStage: "sending" }),
    );
    w.prisma.db.campaignBroadcast = [
      part("p3", "c3", "sent"),
      part("p4", "c4", "scheduled"),
      part("p5", "c5", "cancelled"),
      part("p6", "c6", "completed"),
      part("p9a", "c9", "sent"),
      part("p9b", "c9", "draft", { zernioBroadcastId: null }),
    ];
    w.prisma.db.campaignRecipient.push(
      { id: "r1", workspaceId: WS, campaignId: "c9", phone: "+1", status: "queued" },
      { id: "r2", workspaceId: WS, campaignId: "c9", phone: "+2", status: "sent" },
    );
    return { w, ctrl };
  }

  it("each row's canCancel equals cancellable() for that campaign", async () => {
    const { w, ctrl } = seeded();
    const list = (await ctrl.list(WS)) as any[];
    const byId = new Map(list.map((c) => [c.id, c]));
    expect(Object.fromEntries(list.map((c) => [c.id, c.canCancel]))).toEqual({
      camp: false,
      c1: false,
      c2: true,
      c3: true,
      c4: true,
      c5: false,
      c6: true,
      c7: true,
      c8: false,
      c9: true,
    });
    for (const c of list) expect({ id: c.id, can: c.canCancel }).toEqual({ id: c.id, can: await w.send.cancellable(WS, c.id) });
    // Launch progress rides on the list for launching rows only.
    expect(byId.get("c9").launch).toEqual({ stage: "sending", planned: 2, partitionsTotal: 2, partitionsDone: 1, directSent: 0 });
    expect(byId.get("c6").launch).toBeNull();
  });

  it("uses one partition query for the whole page, and two batched queries for launch progress", async () => {
    const { w, ctrl } = seeded();
    const parts = jest.spyOn(w.prisma.campaignBroadcast, "groupBy");
    const partsFind = jest.spyOn(w.prisma.campaignBroadcast, "findMany");
    const rows = jest.spyOn(w.prisma.campaignRecipient, "groupBy");
    const one = jest.spyOn(w.prisma.campaign, "findFirst");
    await ctrl.list(WS);
    expect(parts.mock.calls.length + partsFind.mock.calls.length).toBe(2); // live check + launch partitions
    expect(rows).toHaveBeenCalledTimes(1);
    expect(one).not.toHaveBeenCalled();
    // Without broadcast or launching rows: no partition query at all.
    parts.mockClear();
    partsFind.mockClear();
    rows.mockClear();
    w.prisma.db.campaign = w.prisma.db.campaign.filter((c: any) => ["camp", "c1", "c2", "c7"].includes(c.id));
    await ctrl.list(WS);
    expect(parts.mock.calls.length + partsFind.mock.calls.length + rows.mock.calls.length).toBe(0);
  });

  it("is workspace-scoped", async () => {
    const { w, ctrl } = seeded();
    w.prisma.db.campaign.push(row("x1", { workspaceId: "ws2", status: "running", sendTransport: "broadcast" }));
    w.prisma.db.campaignBroadcast.push(part("px", "x1", "sent", { workspaceId: "ws2" }));
    const list = (await ctrl.list(WS)) as any[];
    expect(list.some((c) => c.id === "x1")).toBe(false);
  });
});

describe("Minor 1: refresh only moves an active SP-13 campaign, and only forward", () => {
  it("a cancel after partition 1 completed stays cancelled on Refresh", async () => {
    const w = world({ senders: ["A", "B", "C"], contacts: people(6) });
    await w.launch();
    expect(w.camp().status).toBe("running");
    const [p1] = w.partitions();
    w.zernio.broadcasts.get(p1.zernioBroadcastId).status = "completed";
    await w.send.cancel(WS, "camp");
    expect(w.camp().status).toBe("cancelled");
    const updated = await w.send.refresh(WS, "camp");
    expect(updated.status).toBe("cancelled");
    expect(w.camp().status).toBe("cancelled");
    // Counters and the sync time still update.
    expect(w.camp().statsSyncedAt).toBeInstanceOf(Date);
  });

  it("a failed launch whose partition fail() stopped stays failed on Refresh", async () => {
    const w = world({ senders: ["A", "B", "C"], contacts: people(6) });
    const real = w.zernio.sendBroadcast.getMockImplementation()!;
    let n = 0;
    w.zernio.sendBroadcast.mockImplementation(async (id: string) => {
      if (++n === 2) throw new HttpException("Template was deleted", 400);
      return real(id);
    });
    await w.launch();
    expect(w.camp()).toMatchObject({ status: "failed" });
    expect(w.camp().zernioBroadcastId).toBeTruthy();
    await w.send.refresh(WS, "camp");
    expect(w.camp().status).toBe("failed");
  });

  it("running never goes back to scheduled; scheduled still moves to running and running to completed", async () => {
    const w = world({ senders: ["A", "B"], contacts: people(4) });
    await w.launch({ mode: "schedule", scheduledAt: new Date(NOW.getTime() + 2 * H).toISOString() });
    expect(w.camp().status).toBe("scheduled");
    const ids = w.partitions().map((p: any) => p.zernioBroadcastId);
    // Still all scheduled: stays scheduled.
    await w.send.refresh(WS, "camp");
    expect(w.camp().status).toBe("scheduled");
    for (const id of ids) w.zernio.broadcasts.get(id).status = "sending";
    await w.send.refresh(WS, "camp");
    expect(w.camp().status).toBe("running");
    for (const id of ids) w.zernio.broadcasts.get(id).status = "scheduled";
    await w.send.refresh(WS, "camp");
    expect(w.camp().status).toBe("running");
    for (const id of ids) w.zernio.broadcasts.get(id).status = "completed";
    await w.send.syncActive();
    expect(w.camp().status).toBe("completed");
  });
});

describe("Minor 2: a cancelled direct campaign is recounted once", () => {
  it("rows sent before the cancel show in the counters", async () => {
    process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    const w = world({ senders: ["A", "B"], contacts: people(4) });
    const real = w.zernio.sendTemplateToPhone.getMockImplementation()!;
    let n = 0;
    w.zernio.sendTemplateToPhone.mockImplementation(async (input: any) => {
      const res = await real(input);
      if (++n === 2) await w.send.cancel(WS, "camp");
      return res;
    });
    const recount = jest.spyOn(w.tracker, "recountCampaign");
    await w.launch();
    expect(w.camp()).toMatchObject({ status: "cancelled", sendTransport: "direct", sent: 2 });
    expect(recount.mock.calls.filter((c) => c[0] === "camp")).toHaveLength(1);
  });
});

describe("Minor 3: a header-file campaign over the direct limit fails with its own key", () => {
  it("lastError is campaigns.header_direct_too_large, with no send", async () => {
    process.env.CAMPAIGN_DIRECT_MAX = "2";
    const img = { id: "m1", workspaceId: WS, mimeType: "image/png", sizeBytes: 1000, uploadedById: "u" };
    const w = world({ contacts: people(3), campaign: { headerMediaId: "m1" }, template: { headerType: "image" }, media: [img] });
    const thrown: unknown[] = [];
    const fail = (w.runner as any).fail.bind(w.runner);
    jest.spyOn(w.runner as any, "fail").mockImplementation(async (lease: any, e: unknown) => {
      thrown.push(e);
      return fail(lease, e);
    });
    await w.launch();
    expect(w.camp()).toMatchObject({ status: "failed", lastError: "campaigns.header_direct_too_large" });
    expect((thrown[0] as HttpException).getResponse()).toMatchObject({ message: "campaigns.header_direct_too_large", limit: 2, reachable: 3 });
    expect(w.zernio.sendTemplateToPhone).not.toHaveBeenCalled();
    expect(w.zernio.createWhatsAppBroadcast).not.toHaveBeenCalled();
  });

  it("without a header file, too many values still fail with var_map_too_varied", async () => {
    process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    process.env.CAMPAIGN_DIRECT_MAX = "2";
    const w = world({ senders: ["A", "B"], contacts: people(3) });
    await w.launch();
    expect(w.camp()).toMatchObject({ status: "failed", lastError: "campaigns.var_map_too_varied" });
  });
});

describe("Minor 6 (R19): template checks, sweeps and legacy stats go through the shared budget", () => {
  it("the launch template check takes a token per account and a 429 pauses the bucket", async () => {
    const w = world({ senders: ["A", "B"], contacts: people(2) });
    w.send.budget = w.budget;
    const before = w.takes.campaign;
    await w.launch();
    // Two accounts read at launch (the runner's own calls take tokens too, so at least 2).
    expect(w.takes.campaign - before).toBeGreaterThanOrEqual(2);

    const w2 = world({ contacts: people(2) });
    w2.send.budget = w2.budget;
    w2.zernio.whatsappTemplates.mockRejectedValueOnce(new ZernioRateLimitError("slow", 3000));
    expect(await keyOf(w2.send.launch(WS, "camp", { mode: "now" }))).toMatchObject({ status: 502, message: "campaigns.template_check_failed" });
    expect((w2.budget.campaign as any).pause).toHaveBeenCalledWith(3000);
  });

  it("the preview's template check takes a token per account and a 429 pauses the bucket", async () => {
    const w = world({ senders: ["A", "B"], contacts: people(2) });
    w.preview.budget = w.budget;
    await w.preview.preview(WS, { templateId: "tpl", senderChannelIds: ["A", "B"] }, { canViewContacts: false });
    expect(w.takes.campaign).toBe(2);
    w.zernio.whatsappTemplates.mockRejectedValueOnce(new ZernioRateLimitError("slow", 2000));
    const r = await w.preview.preview(WS, { templateId: "tpl", senderChannelIds: ["A"] }, { canViewContacts: false });
    expect(r.templateCheckFailed).toEqual(["A"]);
    expect((w.budget.campaign as any).pause).toHaveBeenCalledWith(2000);
  });

  it("each recipient sweep page takes a token, and a 429 there pauses the bucket", async () => {
    const w = world({ contacts: people(2) });
    await w.launch();
    w.send.budget = w.budget;
    const before = w.takes.campaign;
    await w.send.syncActive();
    // One status read + one recipients page.
    expect(w.zernio.listBroadcastRecipients).toHaveBeenCalledTimes(1);
    expect(w.takes.campaign - before).toBe(2);
    w.zernio.listBroadcastRecipients.mockRejectedValueOnce(new ZernioRateLimitError("slow", 6000));
    await w.send.refresh(WS, "camp");
    expect((w.budget.campaign as any).pause).toHaveBeenCalledWith(6000);
  });

  it("a legacy campaign's stats read takes a token, and a 429 pauses the bucket", async () => {
    const w = world();
    w.send.budget = w.budget;
    w.prisma.db.campaign.push(row("legacy", { status: "running", zernioBroadcastId: "zbL", recipientTracking: false }));
    w.zernio.broadcasts.set("zbL", { id: "zbL", status: "sending", recipients: new Set() });
    await w.send.refresh(WS, "legacy");
    expect(w.takes.campaign).toBe(1);
    w.zernio.getBroadcast.mockRejectedValueOnce(new ZernioRateLimitError("slow", 1500));
    await expect(w.send.refresh(WS, "legacy")).rejects.toBeInstanceOf(ZernioRateLimitError);
    expect((w.budget.campaign as any).pause).toHaveBeenCalledWith(1500);
  });
});
