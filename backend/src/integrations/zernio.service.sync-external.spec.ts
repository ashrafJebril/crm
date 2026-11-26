import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";
import { AiBridgeService } from "./ai-bridge.service";

/**
 * On-demand sync of natively-authored posts, behind the Social feed's Refresh.
 *
 * Why it exists: Zernio's BACKGROUND sync refreshes an account "at most every
 * ~90 minutes", and in production that left a Facebook Page showing zero posts
 * for six hours while the Page plainly had nine. One call to
 * `POST /v1/posts/sync-external` returned `postsFound: 9, postsSynced: 9`
 * instantly, and the Instagram account picked up a post that had been missing
 * all day. Refresh without this only re-reads the same stale cache.
 */
const WS = "ws-1";

function build(channels: Array<{ externalId: string | null; kind: string }>) {
  const prisma: any = {
    workspace: { findUnique: jest.fn().mockResolvedValue({ zernioProfileId: "prof-1" }) },
    channel: { findMany: jest.fn().mockResolvedValue(channels) },
  };
  const client: any = {
    isConfigured: () => true,
    syncExternalPosts: jest
      .fn()
      .mockResolvedValue({ postsFound: 9, postsSynced: 9, skipped: false }),
  };
  const realtime: any = { emitToWorkspace: jest.fn() };
  const svc = new ZernioService(
    prisma as unknown as PrismaService,
    realtime as unknown as RealtimeService,
    {} as unknown as MediaService,
    client as unknown as ZernioClient,
    { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
    { ask: jest.fn() } as never,
    { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
  );
  return { svc, prisma, client, realtime };
}

describe("ZernioService.syncExternalPosts", () => {
  it("syncs every connected social account", async () => {
    const { svc, client } = build([
      { externalId: "acc-fb", kind: "facebook" },
      { externalId: "acc-ig", kind: "instagram" },
    ]);
    const res = await svc.syncExternalPosts(WS);
    expect(client.syncExternalPosts).toHaveBeenCalledWith("acc-fb");
    expect(client.syncExternalPosts).toHaveBeenCalledWith("acc-ig");
    expect(res.synced).toHaveLength(2);
  });

  it("scopes to this workspace's own accounts", async () => {
    // The Zernio API key is global across tenants, so the channel list is the
    // only thing stopping one workspace refreshing another's accounts.
    const { svc, prisma } = build([{ externalId: "acc-fb", kind: "facebook" }]);
    await svc.syncExternalPosts(WS);
    expect(prisma.channel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: WS, provider: "zernio" }),
      }),
    );
  });

  it("skips WhatsApp, which has no posts to sync", async () => {
    const { svc, client } = build([
      { externalId: "acc-wa", kind: "whatsapp" },
      { externalId: "acc-ig", kind: "instagram" },
    ]);
    await svc.syncExternalPosts(WS);
    expect(client.syncExternalPosts).toHaveBeenCalledTimes(1);
    expect(client.syncExternalPosts).toHaveBeenCalledWith("acc-ig");
  });

  it("one dead account does not deny the others", async () => {
    // A disconnected platform answers 401/409. Failing the whole refresh over
    // it would be the stale feed all over again.
    const { svc, client } = build([
      { externalId: "acc-fb", kind: "facebook" },
      { externalId: "acc-ig", kind: "instagram" },
    ]);
    client.syncExternalPosts.mockImplementation(async (id: string) => {
      if (id === "acc-fb") throw new Error("409 needs reconnection");
      return { postsFound: 7, postsSynced: 1, skipped: false };
    });
    const res = await svc.syncExternalPosts(WS);
    const fb = res.synced.find((r) => r.accountId === "acc-fb");
    const ig = res.synced.find((r) => r.accountId === "acc-ig");
    expect(fb?.error).toMatch(/409/);
    expect(ig).toMatchObject({ postsSynced: 1, error: null });
  });

  it("nudges the feed only when something actually changed", async () => {
    const { svc, client, realtime } = build([{ externalId: "acc-ig", kind: "instagram" }]);
    // Zernio's ~15s debounce: nothing fetched, nothing new.
    client.syncExternalPosts.mockResolvedValue({ postsFound: 0, postsSynced: 0, skipped: true });
    await svc.syncExternalPosts(WS);
    expect(realtime.emitToWorkspace).not.toHaveBeenCalled();

    client.syncExternalPosts.mockResolvedValue({ postsFound: 9, postsSynced: 9, skipped: false });
    await svc.syncExternalPosts(WS);
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(WS, "social.updated", {});
  });

  it("does nothing when Zernio is not connected", async () => {
    const { svc, client, prisma } = build([]);
    prisma.workspace.findUnique.mockResolvedValue({ zernioProfileId: null });
    const res = await svc.syncExternalPosts(WS);
    expect(client.syncExternalPosts).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });
});
