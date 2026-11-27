import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";

/**
 * View counts in the feed.
 *
 * Zernio reports the same quantity under `views` and `impressions`, but which
 * of the two it fills depends on the platform. Measured live 2026-11-27
 * against the real account (10 Facebook posts, 7 Instagram):
 *
 *   instagram, every media type  views === impressions   (17/17, 40/40, 27/27…)
 *   facebook video               views === impressions   (284/284, 303/303…)
 *   facebook photo               views 0, impressions 45 / 47 / 29 / 23
 *
 * Reading `views` alone therefore showed nothing under every Facebook photo
 * while Zernio had the number all along.
 */

const WS = "ws1";

function build(posts: unknown[]) {
  const prisma = {
    workspace: { findUnique: jest.fn().mockResolvedValue({ zernioProfileId: "prof1" }) },
    integration: { findFirst: jest.fn().mockResolvedValue(null) },
    channel: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const client = { listPosts: jest.fn().mockResolvedValue(posts) };
  const svc = new ZernioService(
    prisma as unknown as PrismaService,
    {} as unknown as RealtimeService,
    {} as unknown as MediaService,
    client as unknown as ZernioClient,
    { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
    { ask: jest.fn().mockResolvedValue(null) } as never,
    { isConfigured: () => false, notifyInbound: jest.fn() } as never,
  );
  return { svc, client };
}

const post = (analytics: Record<string, number>) => ({
  _id: "p1",
  platform: "facebook",
  analytics,
});

describe("ZernioService.listPosts — view counts", () => {
  it("uses impressions for a Facebook photo, where views is a real 0", async () => {
    const { svc } = build([post({ impressions: 45, reach: 12, likes: 1, views: 0 })]);
    const [row] = await svc.listPosts(WS);
    expect(row.views).toBe(45);
    expect(row.reach).toBe(12);
  });

  it("uses views when both are present and agree", async () => {
    const { svc } = build([post({ impressions: 284, views: 284, reach: 237 })]);
    const [row] = await svc.listPosts(WS);
    expect(row.views).toBe(284);
  });

  it("prefers views over impressions if they ever disagree", async () => {
    // Nothing observed them disagreeing, but views is the metric Meta now
    // names in its own Insights, so it wins.
    const { svc } = build([post({ impressions: 100, views: 90 })]);
    const [row] = await svc.listPosts(WS);
    expect(row.views).toBe(90);
  });

  it("reports nothing — not zero — when insights have not synced", async () => {
    // Observed on one real Facebook post: 5 likes but every analytics field
    // zero and a stale lastUpdated. "0 views" there would be a false claim,
    // so the badge is hidden instead.
    const { svc } = build([post({ impressions: 0, reach: 0, views: 0, likes: 5 })]);
    const [row] = await svc.listPosts(WS);
    expect(row.views).toBeNull();
    expect(row.reach).toBeNull();
    expect(row.likes).toBe(5);
  });

  it("reports nothing when the row carries no analytics at all", async () => {
    const { svc } = build([{ _id: "p1", platform: "facebook" }]);
    const [row] = await svc.listPosts(WS);
    expect(row.views).toBeNull();
    expect(row.reach).toBeNull();
  });
});
