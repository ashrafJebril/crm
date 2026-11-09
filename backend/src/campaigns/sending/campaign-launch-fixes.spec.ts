/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException } from "@nestjs/common";
import { ZernioRateLimitError } from "../../integrations/zernio.client";
import { TokenBucket } from "./zernio-budget";
import { contact, crashOnce, deliveryCounts, ME, world, WS } from "./launch-test-world";

/** SP-13 Task 2, fix round 1 (review I1–I4, m1–m5). */

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
/** Resume until the job is no longer launching (each pass makes the lease stale). */
async function settle(w: ReturnType<typeof world>, max = 30) {
  for (let i = 0; i < max && w.camp().status === "launching"; i++) {
    jest.setSystemTime(new Date(Date.now() + 3 * 60_000));
    await w.resume();
  }
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  delete process.env.CAMPAIGN_MAX_PARTITIONS;
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.CAMPAIGN_MAX_PARTITIONS;
});

describe("I1: a launch that fails after a partition went out stops it, or stays cancellable", () => {
  const scheduled = () => ({ mode: "schedule" as const, scheduledAt: new Date(NOW.getTime() + 24 * H).toISOString() });

  it("cancels the scheduled partition in Zernio before writing failed", async () => {
    const w = world({ senders: ["A", "B", "C"], contacts: people(6) });
    const real = w.zernio.scheduleBroadcast.getMockImplementation()!;
    let n = 0;
    w.zernio.scheduleBroadcast.mockImplementation(async (id: string, at: string) => {
      if (++n === 2) throw new HttpException("Template was deleted", 400);
      return real(id, at);
    });
    await w.launch(scheduled());
    expect(w.camp()).toMatchObject({ status: "failed", lastError: "campaigns.launch_failed" });
    const [p1] = w.zernio.scheduleBroadcast.mock.calls[0];
    expect(w.zernio.cancelBroadcast).toHaveBeenCalledWith(p1);
    expect(w.zernio.broadcasts.get(p1).status).toBe("cancelled");
    // Nothing will reach anyone tomorrow.
    expect(w.zernio.deliveries).toEqual([]);
    expect(await w.send.cancellable(WS, "camp")).toBe(false);
    await expect(w.send.assertDeletable(WS, "camp")).resolves.toBeUndefined();
  });

  it("when that cancel fails, the failed campaign stays cancellable and cannot be deleted until stopped", async () => {
    const w = world({ senders: ["A", "B", "C"], contacts: people(6) });
    const real = w.zernio.scheduleBroadcast.getMockImplementation()!;
    let n = 0;
    w.zernio.scheduleBroadcast.mockImplementation(async (id: string, at: string) => {
      if (++n === 2) throw new HttpException("Template was deleted", 400);
      return real(id, at);
    });
    w.zernio.cancelBroadcast.mockRejectedValueOnce(new HttpException("Zernio down", 502));
    await w.launch(scheduled());
    const [p1] = w.zernio.scheduleBroadcast.mock.calls[0];
    expect(w.camp().status).toBe("failed");
    const live = w.partitions().find((p: any) => p.zernioBroadcastId === p1);
    expect(live).toMatchObject({ stage: "scheduled" });
    expect(live.lastError).toMatch(/Zernio down/);
    expect(await w.send.cancellable(WS, "camp")).toBe(true);
    expect(await keyOf(w.send.assertDeletable(WS, "camp"))).toMatchObject({ status: 400, message: "campaigns.has_live_broadcasts" });

    const res = await w.send.cancel(WS, "camp");
    expect(res.status).toBe("cancelled");
    expect(w.zernio.broadcasts.get(p1).status).toBe("cancelled");
    expect(w.zernio.deliveries).toEqual([]);
    await expect(w.send.assertDeletable(WS, "camp")).resolves.toBeUndefined();
  });
});

describe("I2: cancel cleanup is per partition", () => {
  it("a delete that times out but happened, then reads 404 on resume, still ends cancelled with the sent partition cancelled", async () => {
    const w = world({ senders: ["A", "B"], contacts: people(4) });
    const realSend = w.zernio.sendBroadcast.getMockImplementation()!;
    w.zernio.sendBroadcast.mockImplementation(async (id: string) => {
      await realSend(id);
      await w.send.cancel(WS, "camp");
    });
    const realDelete = w.zernio.deleteBroadcast.getMockImplementation()!;
    w.zernio.deleteBroadcast.mockImplementationOnce(async (id: string) => {
      await realDelete(id);
      throw new HttpException("Zernio API timed out", 504);
    });
    const statuses: string[] = [];
    const um = w.prisma.campaign.updateMany;
    w.prisma.campaign.updateMany = jest.fn((a: any) => {
      if (a.data?.status) statuses.push(a.data.status);
      return um(a);
    });
    await w.launch();
    const [sentId] = w.zernio.sendBroadcast.mock.calls[0];
    // The other partition was still handled in the same pass.
    expect(w.zernio.cancelBroadcast).toHaveBeenCalledWith(sentId);
    expect(w.camp().status).toBe("launching");
    await settle(w);
    expect(w.camp()).toMatchObject({ status: "cancelled", launchStage: "done" });
    expect(statuses).not.toContain("failed");
    expect(w.partitions().map((p: any) => p.stage)).toEqual(["cancelled", "cancelled"]);
    expect(w.notifications.notify).not.toHaveBeenCalled();
  });

  it("a partition that cannot be confirmed is noted, and the campaign still ends cancelled (never failed)", async () => {
    const w = world({ senders: ["A", "B"], contacts: people(4) });
    const realSend = w.zernio.sendBroadcast.getMockImplementation()!;
    w.zernio.sendBroadcast.mockImplementation(async (id: string) => {
      await realSend(id);
      await w.send.cancel(WS, "camp");
    });
    w.zernio.cancelBroadcast.mockRejectedValue(new HttpException("Zernio down", 502));
    await w.launch();
    await settle(w);
    expect(w.camp().status).toBe("cancelled");
    const [sentId] = w.zernio.sendBroadcast.mock.calls[0];
    const p = w.partitions().find((x: any) => x.zernioBroadcastId === sentId);
    expect(p.lastError).toMatch(/Zernio down/);
    // The other partition (a draft) was deleted regardless.
    expect(w.zernio.broadcasts.size).toBe(1);
    expect(w.notifications.notify).not.toHaveBeenCalled();
  });
});

describe("I3: launchAttempts counts consecutive failures without progress", () => {
  it("a long direct campaign with 6 scattered transient errors completes", async () => {
    process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    const w = world({ senders: ["A", "B"], contacts: people(20) });
    const real = w.zernio.sendTemplateToPhone.getMockImplementation()!;
    let n = 0;
    w.zernio.sendTemplateToPhone.mockImplementation(async (input: any) => {
      n++;
      if ([2, 5, 8, 11, 14, 17].includes(n)) throw new HttpException("Bad gateway", 502);
      return real(input);
    });
    await w.launch();
    await settle(w);
    expect(w.camp()).toMatchObject({ status: "running", sendTransport: "direct" });
    expect(deliveryCounts(w.zernio).size).toBe(20);
    expect([...deliveryCounts(w.zernio).values()].every((c) => c === 1)).toBe(true);
    expect(w.notifications.notify).not.toHaveBeenCalled();
  });
});

describe("I4: a direct send's body is byte-identical across retries of its Idempotency-Key", () => {
  const img = { id: "m1", workspaceId: WS, mimeType: "image/png", sizeBytes: 1000, uploadedById: "u1" };

  it("the header link is resolved once per partition, stored as __headerLink, and reused on resume", async () => {
    const w = world({ contacts: people(3), campaign: { headerMediaId: "m1" }, template: { headerType: "image" }, media: [img] });
    let sig = 0;
    w.media.resolveExternalUrl.mockImplementation(async (_ws: string, id: string) => `https://cdn.test/${id}?sig=${++sig}`);
    crashOnce(w.prisma.campaignRecipient, "updateMany", (a) => !!a.data?.messageId);
    await w.launch();
    expect(w.camp().status).toBe("launching");
    await w.resume();
    expect(w.camp()).toMatchObject({ status: "running" });
    expect(w.rows().every((r: any) => r.status === "sent" && r.messageId)).toBe(true);
    expect([...deliveryCounts(w.zernio).values()]).toEqual([1, 1, 1]);
    expect(w.media.resolveExternalUrl).toHaveBeenCalledTimes(1);
    expect(w.partitions()[0].variables.__headerLink).toBe("https://cdn.test/m1?sig=1");
    for (const [input] of w.zernio.sendTemplateToPhone.mock.calls as any[]) expect(input.headerMedia).toEqual({ link: "https://cdn.test/m1?sig=1" });
  });

  it("a 409/422 on a row with a prior attempt is launch:unconfirmed; on a first attempt it is a provider failure", async () => {
    process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    const w = world({ senders: ["A", "B"], contacts: people(3) });
    crashOnce(w.prisma.campaignRecipient, "updateMany", (a) => !!a.data?.messageId);
    await w.launch();
    const real = w.zernio.sendTemplateToPhone.getMockImplementation()!;
    let n = 0;
    w.zernio.sendTemplateToPhone.mockImplementation(async (input: any) => {
      n++;
      if (n === 1) throw new HttpException("Idempotency key in use", 409); // the resumed row
      if (n === 2) throw new HttpException("Invalid parameter", 422); // a first attempt
      return real(input);
    });
    await w.resume();
    // Sender A holds c000 (crashed after its send) and c002; sender B holds c001.
    const by = Object.fromEntries(w.rows().map((r: any) => [r.contactId, [r.status, r.failureCode]]));
    expect(by).toEqual({
      c000: ["failed", "launch:unconfirmed"],
      c002: ["failed", "provider:unknown"],
      c001: ["sent", null],
    });
  });
});

describe("m1: account-wide rejections stop the job", () => {
  it("a revoked number fails the campaign on the first send instead of failing every row", async () => {
    process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    const w = world({ senders: ["A", "B"], contacts: people(6) });
    w.zernio.sendTemplateToPhone.mockRejectedValue(
      new HttpException("Your WhatsApp connection was removed by Meta. Reconnect WhatsApp in Settings → Integrations, then try again.", 400),
    );
    await w.launch();
    expect(w.camp()).toMatchObject({ status: "failed", lastError: "campaigns.launch_failed" });
    expect(w.zernio.sendTemplateToPhone).toHaveBeenCalledTimes(1);
  });

  it("20 consecutive identical rejections stop the job", async () => {
    process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    const w = world({ senders: ["A", "B"], contacts: people(30) });
    w.zernio.sendTemplateToPhone.mockRejectedValue(new HttpException("Parameter format does not match", 400));
    await w.launch();
    expect(w.camp().status).toBe("failed");
    expect(w.zernio.sendTemplateToPhone).toHaveBeenCalledTimes(20);
  });
});

describe("m2: a send confirmed after cancel still stamps its row", () => {
  it("the in-flight row is sent with its messageId; the rest stay queued", async () => {
    process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    const w = world({ senders: ["A", "B"], contacts: people(4) });
    const real = w.zernio.sendTemplateToPhone.getMockImplementation()!;
    w.zernio.sendTemplateToPhone.mockImplementationOnce(async (input: any) => {
      const res = await real(input);
      await w.send.cancel(WS, "camp");
      return res;
    });
    await w.launch();
    expect(w.camp().status).toBe("cancelled");
    const sent = w.rows().filter((r: any) => r.status === "sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].messageId).toBeTruthy();
    expect(w.rows().filter((r: any) => r.status === "queued")).toHaveLength(3);
  });
});

describe("m3: Retry-After pauses the shared budget; sweep status reads take tokens", () => {
  it("TokenBucket.pause holds every caller until the wait is over", async () => {
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const b = new TokenBucket(60, clock, 5);
    b.pause(7000);
    await b.take();
    expect(t).toBe(7000);
  });

  it("the runner pauses the campaign bucket on a 429", async () => {
    const w = world({ contacts: people(2) });
    w.zernio.createWhatsAppBroadcast.mockRejectedValueOnce(new ZernioRateLimitError("slow", 4000));
    await w.launch();
    expect((w.budget.campaign as any).pause).toHaveBeenCalledWith(4000);
    expect(w.camp().status).toBe("running");
  });

  it("the sweep's per-partition getBroadcast takes a budget token each", async () => {
    const w = world({ senders: ["A", "B", "C"], contacts: people(6) });
    await w.launch();
    w.send.budget = w.budget;
    const before = w.takes.campaign;
    const reads = w.zernio.getBroadcast.mock.calls.length;
    await w.send.syncActive();
    expect(w.zernio.getBroadcast.mock.calls.length - reads).toBe(3);
    expect(w.takes.campaign - before).toBe(3);
  });
});

describe("m4: a failed direct campaign is recounted once", () => {
  it("rows sent before the failure show in the counters", async () => {
    process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    const w = world({ senders: ["A", "B"], contacts: people(4) });
    const real = w.zernio.sendTemplateToPhone.getMockImplementation()!;
    let n = 0;
    w.zernio.sendTemplateToPhone.mockImplementation(async (input: any) => {
      if (++n === 3) throw new HttpException("Unauthorized", 401);
      return real(input);
    });
    await w.launch();
    expect(w.camp()).toMatchObject({ status: "failed", sent: 2 });
  });
});

describe("m5: scheduler batches are ordered and skip in-flight launches", () => {
  it("orders stale launches by heartbeat then id, and due ones by scheduledAt then id", async () => {
    const w = world({ contacts: people(1) });
    const spy = jest.spyOn(w.prisma.campaign, "findMany");
    await w.scheduler.sweep(new Date());
    const [stale, due] = spy.mock.calls.map((c: any[]) => c[0]);
    expect(stale.orderBy).toEqual([{ launchHeartbeatAt: "asc" }, { id: "asc" }]);
    expect(stale.where.id).toEqual({ notIn: [] });
    expect(due.orderBy).toEqual([{ scheduledAt: "asc" }, { id: "asc" }]);
    void ME;
  });
});
