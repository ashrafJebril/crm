import { AiBridgeService } from "./ai-bridge.service";
import { HttpException } from "@nestjs/common";
import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";

/**
 * analyticsOverview — Zernio's `GET /analytics` only aggregates post COUNTS
 * at the page level (spike, 2026-08-13:
 * docs/superpowers/plans/2026-08-13-analytics-spike-findings.md), so totals
 * are summed here client-side from `posts[].platforms[]` breakdown entries
 * (the LIVE field name — not the docs' claimed `platformAnalytics`), which
 * attribute correctly for a post cross-posted to more than one platform.
 * Follower history comes from a separate per-ACCOUNT endpoint
 * (`GET /accounts/follower-stats`) joined back to a platform name via its
 * `accounts[]` array. The service never throws: no profile -> not_connected;
 * a 402, or the documented (unconfirmed-live) 403 add-on shape -> plan;
 * anything else -> upstream.
 */
describe("ZernioService.analyticsOverview", () => {
  let prisma: { workspace: { findUnique: jest.Mock } };
  let client: { getAnalytics: jest.Mock; getFollowerStats: jest.Mock };
  let svc: ZernioService;

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const daysAgo = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return iso(d);
  };

  beforeEach(() => {
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ zernioProfileId: "prof1" }) },
    };
    client = {
      getAnalytics: jest.fn(),
      getFollowerStats: jest.fn(),
    };
    svc = new ZernioService(
      prisma as unknown as PrismaService,
      { emitToWorkspace: jest.fn() } as unknown as RealtimeService,
      {} as unknown as MediaService,
      client as unknown as ZernioClient,
      { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
        { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
);
  });

  it("returns not_connected without a profile", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ zernioProfileId: null });
    const res = await svc.analyticsOverview("ws1", 7);
    expect(res).toEqual({ available: false, reason: "not_connected" });
    expect(client.getAnalytics).not.toHaveBeenCalled();
  });

  it("maps per-platform metrics (via posts[].platforms[] breakdown) and follower series (fixed output contract)", async () => {
    // Live shape (spike-verified): each post carries a platforms[] breakdown
    // and each breakdown entry has its OWN analytics object — that's what
    // gets summed, not the post's rolled-up `analytics`.
    client.getAnalytics.mockResolvedValue({
      hasAnalyticsAccess: true,
      rows: [
        {
          _id: "p1",
          platforms: [
            {
              platform: "facebook",
              accountId: "acc-fb",
              // engagementRate present here on purpose: it must NOT leak into
              // the output's count-shaped `engagement` slot (fix round 1).
              analytics: { impressions: 100, likes: 5, comments: 2, shares: 1, engagementRate: 1.35 },
            },
          ],
        },
        {
          _id: "p2",
          platforms: [
            {
              platform: "facebook",
              accountId: "acc-fb",
              analytics: { impressions: 50, likes: 3, comments: 0, shares: 0 },
            },
          ],
        },
        {
          _id: "p3",
          // no impressions on these Instagram breakdown rows
          platforms: [
            { platform: "instagram", accountId: "acc-ig", analytics: { likes: 7, comments: 4 } },
          ],
        },
        {
          _id: "p4",
          platforms: [
            { platform: "instagram", accountId: "acc-ig", analytics: { likes: 4, comments: 0 } },
          ],
        },
      ],
    });
    client.getFollowerStats.mockResolvedValue({
      accounts: [
        { _id: "acc-fb", platform: "facebook" },
        { _id: "acc-ig", platform: "instagram" },
      ],
      stats: {
        "acc-fb": [
          { date: daysAgo(7), followers: 100 },
          { date: daysAgo(0), followers: 110 },
        ],
        "acc-ig": [
          { date: daysAgo(7), followers: 200 },
          { date: daysAgo(0), followers: 195 },
        ],
      },
    });

    const res = await svc.analyticsOverview("ws1", 7);
    expect(res.available).toBe(true);
    expect(res.windowDays).toBe(7);

    const fb = res.platforms!.find((p) => p.platform === "facebook")!;
    expect(fb.impressions).toBe(150);
    expect(fb.likes).toBe(8);
    // engagementRate (a %) is categorically absent as a COUNT upstream —
    // the output's engagement slot stays null even though one row above
    // carried an engagementRate.
    expect(fb.engagement).toBeNull();
    // p1 + p2 both contributed a facebook breakdown entry -> 2 posts summed.
    expect(fb.postCount).toBe(2);
    expect(fb.followers).toEqual({
      current: 110,
      delta: 10,
      series: [
        { date: daysAgo(7), count: 100 },
        { date: daysAgo(0), count: 110 },
      ],
    });

    const ig = res.platforms!.find((p) => p.platform === "instagram")!;
    expect(ig.impressions).toBeNull(); // absent metric -> null, never 0
    expect(ig.likes).toBe(11);
    expect(ig.engagement).toBeNull();
    // p3 + p4 both contributed an instagram breakdown entry -> 2 posts summed.
    expect(ig.postCount).toBe(2);
    expect(ig.followers.delta).toBe(-5);

    expect(client.getAnalytics).toHaveBeenCalledWith("prof1", {
      fromDate: daysAgo(7),
      toDate: daysAgo(0),
    });
    expect(client.getFollowerStats).toHaveBeenCalledWith("prof1", {
      fromDate: daysAgo(7),
      toDate: daysAgo(0),
      granularity: "daily",
    });
  });

  it("reports postCount:0 for a platform surfaced only via follower data (no analytics rows)", async () => {
    client.getAnalytics.mockResolvedValue({ rows: [], hasAnalyticsAccess: true });
    client.getFollowerStats.mockResolvedValue({
      accounts: [{ _id: "acc-wa", platform: "whatsapp" }],
      stats: {
        "acc-wa": [
          { date: daysAgo(7), followers: 50 },
          { date: daysAgo(0), followers: 52 },
        ],
      },
    });

    const res = await svc.analyticsOverview("ws1", 7);
    const wa = res.platforms!.find((p) => p.platform === "whatsapp")!;
    expect(wa.postCount).toBe(0);
    expect(wa.impressions).toBeNull();
    expect(wa.followers.current).toBe(52);
  });

  it("collapses hasAnalyticsAccess:false (a 200, not an error) into reason:plan", async () => {
    // Spike-verified shape: GET /analytics can answer 200 with an explicit
    // hasAnalyticsAccess:false rather than a 402/403 — a second, independent
    // plan-gate signal alongside the error-shape matching below.
    client.getAnalytics.mockResolvedValue({ rows: [], hasAnalyticsAccess: false });
    client.getFollowerStats.mockResolvedValue({ accounts: [], stats: {} });
    const res = await svc.analyticsOverview("ws1", 7);
    expect(res).toEqual({ available: false, reason: "plan" });
  });

  it("collapses a 402 into reason:plan", async () => {
    client.getAnalytics.mockRejectedValue(new HttpException("Analytics add-on required", 402));
    const res = await svc.analyticsOverview("ws1", 30);
    expect(res).toEqual({ available: false, reason: "plan" });
  });

  it("collapses the documented 403 add-on-required shape into reason:plan", async () => {
    // Documented (not live-verified — this workspace is never gated) shape
    // from docs.zernio.com/accounts/get-follower-stats:
    // { error: "Analytics add-on required", requiresAddon: true } as HTTP 403.
    client.getAnalytics.mockRejectedValue(new HttpException("Analytics add-on required", 403));
    const res = await svc.analyticsOverview("ws1", 30);
    expect(res).toEqual({ available: false, reason: "plan" });
  });

  it("collapses an ordinary 403 (no add-on wording) into reason:upstream", async () => {
    client.getAnalytics.mockRejectedValue(new HttpException("Forbidden", 403));
    const res = await svc.analyticsOverview("ws1", 7);
    expect(res).toEqual({ available: false, reason: "upstream" });
  });

  it("collapses other upstream failures into reason:upstream", async () => {
    client.getAnalytics.mockRejectedValue(new HttpException("Zernio API unreachable", 502));
    const res = await svc.analyticsOverview("ws1", 7);
    expect(res).toEqual({ available: false, reason: "upstream" });
  });
});
