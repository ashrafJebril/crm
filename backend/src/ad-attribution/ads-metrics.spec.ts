import { HttpException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { makeFakePrisma } from "../channels/test-prisma";
import { AdsMetricsService } from "./ads-metrics.service";
import { costPerConversation, daysBetween, round4 } from "./ads-metrics";

const NOW = new Date("2026-11-10T09:00:00.000Z");
const RANGE = { from: "2026-11-01", to: "2026-11-10" };

let seq = 0;
function seed(opts: { conn?: Record<string, unknown> | null; wsTz?: string } = {}) {
  const prisma = makeFakePrisma({
    workspace: [
      { id: "wsA", timezone: opts.wsTz ?? "UTC" },
      { id: "wsB", timezone: "UTC" },
    ],
  } as never);
  if (opts.conn !== null) {
    prisma.db.metaAdsConnection.push({
      id: "mac",
      workspaceId: "wsA",
      status: "active",
      tokenEnc: "enc:v1:x",
      pendingTokenEnc: null,
      adAccountId: "act_111",
      adAccountName: "Main",
      currency: "USD",
      timezone: "UTC",
      spendBackfilledAt: NOW,
      ...(opts.conn ?? {}),
    });
  }
  const ad = (id: string, over: Record<string, unknown> = {}) => {
    prisma.db.adSource.push({
      id,
      workspaceId: "wsA",
      sourceType: "ad",
      sourceId: `src_${id}`,
      headline: null,
      body: null,
      adName: null,
      adSetName: null,
      campaignName: null,
      namesFrom: null,
      mediaType: null,
      mediaUrl: null,
      mediaId: null,
      sourceUrl: null,
      adAccountId: "act_111",
      firstReferredAt: null,
      lastReferredAt: null,
      ...over,
    });
  };
  const touch = (adSourceId: string, conversationId: string, at: string, workspaceId = "wsA") =>
    prisma.db.adReferral.push({
      id: `r${++seq}`,
      workspaceId,
      adSourceId,
      conversationId,
      contactId: "c",
      messageId: `m${seq}`,
      provider: "meta",
      firstTouch: false,
      referredAt: new Date(at),
    });
  const spend = (adSourceId: string, day: string, amount: string, currency = "USD", adAccountId = "act_111") =>
    prisma.db.adSpendDaily.push({
      id: `s${++seq}`,
      workspaceId: "wsA",
      adSourceId,
      adAccountId,
      date: new Date(`${day}T00:00:00.000Z`),
      spend: new Prisma.Decimal(amount),
      currency,
      syncedAt: NOW,
    });
  return { prisma, svc: new AdsMetricsService(prisma), ad, touch, spend };
}

async function rejection(p: Promise<unknown>) {
  const e = await p.then(
    () => null,
    (err) => err,
  );
  expect(e).toBeInstanceOf(HttpException);
  return { status: (e as HttpException).getStatus(), body: (e as HttpException).getResponse() };
}

describe("SP-15 ad metrics", () => {
  it("cost per conversation = spend / started (0 started → null)", async () => {
    // Pure.
    expect(costPerConversation(120.5, 4)).toBe(30.125);
    expect(costPerConversation(50, 0)).toBeNull();
    expect(costPerConversation(null, 3)).toBeNull();
    expect(costPerConversation(10, 3)).toBe(3.3333);
    expect(costPerConversation(2, 3)).toBe(0.6667);
    expect(round4(1.00005)).toBe(1.0001);
    expect(round4(0.1 + 0.2)).toBe(0.3);

    // Through GET /ad-sources/overview.
    const w = seed();
    w.ad("A", { adName: "Spring" });
    w.ad("B");
    w.ad("C");
    for (const c of ["cv1", "cv2", "cv3", "cv4"]) w.touch("A", c, "2026-11-05T10:00:00.000Z");
    w.spend("A", "2026-11-05", "100.25");
    w.spend("A", "2026-11-06", "20.25");
    w.spend("B", "2026-11-05", "50");
    // An ad whose spend is in a second currency: its own total, never summed with USD.
    w.touch("C", "cv9", "2026-11-07T10:00:00.000Z");
    w.touch("C", "cv8", "2026-11-07T11:00:00.000Z");
    w.spend("C", "2026-11-07", "10", "EUR");

    const o = await w.svc.overview("wsA", RANGE, NOW);
    const by = Object.fromEntries(o.ads.map((a) => [a.id, a]));
    expect(by.A).toMatchObject({ started: 4, spend: { amount: 120.5, currency: "USD" }, costPerConversation: 30.125 });
    expect(by.B).toMatchObject({ started: 0, spend: { amount: 50, currency: "USD" }, costPerConversation: null });
    expect(by.C).toMatchObject({ started: 2, spend: { amount: 10, currency: "EUR" }, costPerConversation: 5 });
    expect(o.totals).toEqual({
      started: 6,
      byCurrency: [
        { currency: "EUR", spend: 10, started: 2, costPerConversation: 5 },
        { currency: "USD", spend: 170.5, started: 4, costPerConversation: 42.625 },
      ],
    });
    expect(o.ads.map((a) => a.id)).toEqual(["A", "C", "B"]);
    expect(o.totalAds).toBe(3);
    expect(o.range).toEqual({ from: "2026-11-01", to: "2026-11-10", tz: "UTC" });
    const d5 = o.daily.find((d) => d.date === "2026-11-05")!;
    expect(d5).toEqual({ date: "2026-11-05", started: 4, spend: { USD: 150.25 } });
    expect(o.daily.find((d) => d.date === "2026-11-07")).toEqual({ date: "2026-11-07", started: 2, spend: { USD: 0, EUR: 10 } });
    expect(o.daily).toHaveLength(10);
  });

  it("spend unknown (no active connection) with 3 started → cost null, spend null", async () => {
    const w = seed({ conn: null });
    w.ad("A");
    for (const c of ["cv1", "cv2", "cv3"]) w.touch("A", c, "2026-11-05T10:00:00.000Z");
    w.spend("A", "2026-11-05", "30");
    const o = await w.svc.overview("wsA", RANGE, NOW);
    expect(o.ads[0]).toMatchObject({ started: 3, spend: null, costPerConversation: null });
    expect(o.totals).toEqual({ started: 3, byCurrency: [] });
    expect(o.connection).toBeNull();
    expect(o.daily.every((d) => d.spend === null)).toBe(true);
  });
});

describe("spend is unknown without an active connection", () => {
  const cases: Array<[string, Record<string, unknown> | null]> = [
    ["needs_reconnect", { status: "needs_reconnect" }],
    ["disconnected", { status: "disconnected", tokenEnc: null }],
    ["no row", null],
  ];
  it.each(cases)("%s → spend null, never {amount: 0}", async (_name, conn) => {
    const w = seed({ conn });
    w.ad("A");
    w.touch("A", "cv1", "2026-11-05T10:00:00.000Z");
    w.spend("A", "2026-11-05", "12");
    const o = await w.svc.overview("wsA", RANGE, NOW);
    expect(o.ads[0].spend).toBeNull();
    expect(o.ads[0].costPerConversation).toBeNull();
    const d = await w.svc.detail("wsA", "A", RANGE, NOW);
    expect(d.spend).toBeNull();
    expect(d.daily!.every((x) => x.spend === null)).toBe(true);
  });

  it("an ad of another ad account reads Unknown; a connected ad with no spend rows reads 0", async () => {
    const w = seed();
    w.ad("other", { adAccountId: "act_999" });
    w.ad("unknownAcct", { adAccountId: null });
    w.ad("quiet");
    w.touch("other", "cv1", "2026-11-05T10:00:00.000Z");
    w.touch("unknownAcct", "cv2", "2026-11-05T10:00:00.000Z");
    w.touch("quiet", "cv3", "2026-11-05T10:00:00.000Z");
    w.spend("other", "2026-11-05", "9", "USD", "act_999");
    const o = await w.svc.overview("wsA", RANGE, NOW);
    const by = Object.fromEntries(o.ads.map((a) => [a.id, a]));
    expect(by.other.spend).toBeNull();
    expect(by.unknownAcct.spend).toBeNull();
    expect(by.quiet.spend).toEqual({ amount: 0, currency: "USD" });
    expect(by.quiet.costPerConversation).toBe(0);
    // The other account's spend never reaches the totals or the chart.
    expect(o.totals.byCurrency).toEqual([{ currency: "USD", spend: 0, started: 1, costPerConversation: 0 }]);
    expect(o.daily.find((d) => d.date === "2026-11-05")!.spend).toEqual({ USD: 0 });
  });
});

describe("started counts distinct conversations per ad in range", () => {
  it("two touches by one conversation count 1; touches outside the range are excluded", async () => {
    const w = seed();
    w.ad("A");
    w.touch("A", "cv1", "2026-11-03T10:00:00.000Z");
    w.touch("A", "cv1", "2026-11-04T10:00:00.000Z");
    w.touch("A", "cv2", "2026-10-31T23:59:59.000Z"); // before the range
    w.touch("A", "cv3", "2026-11-11T00:00:00.000Z"); // after the range
    w.touch("A", "cv4", "2026-11-10T23:59:59.000Z");
    w.touch("A", "cvX", "2026-11-05T10:00:00.000Z", "wsB"); // another workspace
    const o = await w.svc.overview("wsA", RANGE, NOW);
    expect(o.ads[0].started).toBe(2);
    const d = await w.svc.detail("wsA", "A", RANGE, NOW);
    expect(d.started).toBe(2);
    // Each conversation counts on its first touch's day.
    expect(d.daily!.filter((x) => x.started > 0)).toEqual([
      { date: "2026-11-03", started: 1, spend: 0 },
      { date: "2026-11-10", started: 1, spend: 0 },
    ]);
  });

  it("day buckets use the ad account's timezone when connected, else the workspace's (ruling 8)", async () => {
    const at = "2026-11-05T22:30:00.000Z"; // 11-06 01:30 in Riyadh
    const connected = seed({ wsTz: "UTC", conn: { timezone: "Asia/Riyadh" } });
    connected.ad("A");
    connected.touch("A", "cv1", at);
    const o1 = await connected.svc.overview("wsA", RANGE, NOW);
    expect(o1.range.tz).toBe("Asia/Riyadh");
    expect(o1.daily.find((d) => d.started)!.date).toBe("2026-11-06");

    const workspaceOnly = seed({ wsTz: "UTC", conn: { status: "disconnected", timezone: "Asia/Riyadh" } });
    workspaceOnly.ad("A");
    workspaceOnly.touch("A", "cv1", at);
    const o2 = await workspaceOnly.svc.overview("wsA", RANGE, NOW);
    expect(o2.range.tz).toBe("UTC");
    expect(o2.daily.find((d) => d.started)!.date).toBe("2026-11-05");
  });

  it("a range over 366 days or malformed is 400 ads.range_invalid", async () => {
    const w = seed();
    w.ad("A");
    for (const q of [{ from: "2025-01-01", to: "2026-11-10" }, { from: "2026-13-01", to: "2026-11-10" }, { from: "2026-11-10", to: "2026-11-01" }, { from: "x" }]) {
      expect(await rejection(w.svc.overview("wsA", q, NOW))).toEqual({ status: 400, body: { statusCode: 400, message: "ads.range_invalid" } });
      expect((await rejection(w.svc.detail("wsA", "A", q, NOW))).status).toBe(400);
    }
    // Exactly 366 days is allowed; the default is the last 30 days.
    await w.svc.overview("wsA", { from: "2025-11-10", to: "2026-11-10" }, NOW);
    expect((await w.svc.overview("wsA", {}, NOW)).range).toEqual({ from: "2026-10-12", to: "2026-11-10", tz: "UTC" });
  });
});

describe("GET /ad-sources/:id", () => {
  it("returns the card with a daily series", async () => {
    const w = seed();
    w.ad("A", { headline: "Spring sale", mediaId: "med1", mediaUrl: "https://x.fbcdn.net/a.jpg", lastReferredAt: new Date("2026-11-05T10:00:00.000Z") });
    w.touch("A", "cv1", "2026-11-05T10:00:00.000Z");
    w.spend("A", "2026-11-05", "7.5");
    const d = await w.svc.detail("wsA", "A", { from: "2026-11-04", to: "2026-11-06" }, NOW);
    expect(d).toMatchObject({
      id: "A",
      sourceId: "src_A",
      headline: "Spring sale",
      imageUrl: "/api/media/med1/file",
      started: 1,
      spend: { amount: 7.5, currency: "USD" },
      costPerConversation: 7.5,
      daily: [
        { date: "2026-11-04", started: 0, spend: 0 },
        { date: "2026-11-05", started: 1, spend: 7.5 },
        { date: "2026-11-06", started: 0, spend: 0 },
      ],
    });
    expect(JSON.stringify(d)).not.toContain("ctwaClid");
  });

  it("foreign ids return 404 on SP-15 routes (part 2)", async () => {
    const w = seed();
    w.prisma.db.adSource.push({ id: "B1", workspaceId: "wsB", sourceType: "ad", sourceId: "1" });
    expect(await rejection(w.svc.detail("wsA", "B1", RANGE, NOW))).toEqual({ status: 404, body: { statusCode: 404, message: "ads.not_found" } });
    expect((await rejection(w.svc.detail("wsA", "missing", RANGE, NOW))).status).toBe(404);
  });

  it("daysBetween is inclusive", () => {
    expect(daysBetween("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });
});
