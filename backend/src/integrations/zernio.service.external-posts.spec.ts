import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";
import { AiBridgeService } from "./ai-bridge.service";
import { ChannelResolver } from "../channels/channel-resolver.service";

/**
 * `post.external.*` — a post written natively on the platform was detected,
 * changed or removed by Zernio's roughly-hourly native-post sync. On a freshly
 * connected account the created event fires once per existing post, which is
 * the backfill.
 *
 * These replaced `analytics.synced` as the Social feed's signal. That event
 * reports an analytics cycle and, per Zernio's docs, "concerns analytics, not
 * whether native posts are detected" — it only ever correlated with new posts
 * by luck. It is still handled, as a weaker nudge.
 */
const WS = "ws-1";

function build(opts: { channel?: boolean; workspace?: boolean } = {}) {
  const prisma: any = {
    workspace: {
      findFirst: jest.fn().mockResolvedValue(opts.workspace === false ? null : { id: WS }),
    },
  };
  const channels = {
    forInbound: jest
      .fn()
      .mockResolvedValue(opts.channel === false ? null : { id: "ch-1", workspaceId: WS, kind: "facebook" }),
  };
  const realtime: any = { emitToWorkspace: jest.fn() };
  const svc = new ZernioService(
    prisma as unknown as PrismaService,
    realtime as unknown as RealtimeService,
    {} as unknown as MediaService,
    {} as unknown as ZernioClient,
    { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
    { ask: jest.fn().mockResolvedValue(null) } as never,
    { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
    undefined,
    undefined,
    channels as unknown as ChannelResolver,
  );
  return { svc, prisma, realtime, channels };
}

const externalPost = (event: string) => ({
  event,
  post: { id: "676984402156407_123", source: "external" },
  account: { accountId: "acc-fb", platform: "facebook", username: "kewy.ai.official" },
  profiles: [{ id: "prof-1", externalId: null }],
  timestamp: "2026-11-25T17:00:00.000Z",
});

describe("ZernioService — external post events", () => {
  it.each(["post.external.created", "post.external.updated", "post.external.deleted"])(
    "%s nudges the feed",
    async (event) => {
      const { svc, realtime } = build();
      await svc.handleEvent(externalPost(event) as never);
      expect(realtime.emitToWorkspace).toHaveBeenCalledWith(WS, "social.updated", {});
    },
  );

  it("resolves the workspace from the account id", async () => {
    // post.external.* carries account.accountId, which maps to a Channel —
    // more direct than the profile and the documented "canonical field for
    // account filtering".
    const { svc, channels, prisma } = build();
    await svc.handleEvent(externalPost("post.external.created") as never);
    expect(channels.forInbound).toHaveBeenCalledWith("zernio", "acc-fb");
    expect(prisma.workspace.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to the profiles array when the account is unknown", async () => {
    // An account connected but not yet mirrored into a Channel still has to
    // reach its workspace, or the first backfill after connecting is lost —
    // which is exactly the window that matters.
    const { svc, prisma, realtime } = build({ channel: false });
    await svc.handleEvent(externalPost("post.external.created") as never);
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { zernioProfileId: "prof-1" } }),
    );
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(WS, "social.updated", {});
  });

  it("stays quiet when nothing here owns the account", async () => {
    // The Zernio API key is shared across tenants, so events arrive for
    // profiles no workspace owns; emitting would refresh a stranger's feed.
    const { svc, realtime } = build({ channel: false, workspace: false });
    const res = await svc.handleEvent(externalPost("post.external.created") as never);
    expect(realtime.emitToWorkspace).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true });
  });

  it("still handles analytics.synced, via the profile", async () => {
    const { svc, realtime } = build({ channel: false });
    await svc.handleEvent({
      type: "analytics.synced",
      data: { profileId: "prof-1" },
    } as never);
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(WS, "social.updated", {});
  });
});
