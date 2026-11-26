import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";
import { AiBridgeService } from "./ai-bridge.service";

/**
 * Instagram options reaching Zernio.
 *
 * Until now `publish` sent only content, platforms, media URLs and a
 * schedule, so none of Instagram's options were reachable at all. The things
 * worth pinning here are the ones that break quietly: options landing on the
 * WRONG platform entry, and the media shape switching under posts that never
 * asked for alt text.
 */
const WS = "ws-1";

function build() {
  const prisma: any = {
    integration: {
      findMany: jest.fn().mockResolvedValue([
        { platform: "instagram", pageId: "acc-ig" },
        { platform: "facebook", pageId: "acc-fb" },
      ]),
    },
    channel: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const media: any = {
    get: jest.fn(async (_ws: string, id: string) => ({
      storageKind: "spaces",
      id,
      mimeType: id.startsWith("v") ? "video/mp4" : "image/jpeg",
      fileName: `${id}.jpg`,
    })),
    resolveExternalUrl: jest.fn(async (_ws: string, id: string) => `https://cdn.test/${id}.jpg`),
    mintPublicToken: jest.fn(),
  };
  const client: any = {
    isConfigured: () => true,
    createPost: jest.fn().mockResolvedValue({ id: "post-1", status: "published" }),
  };
  const svc = new ZernioService(
    prisma as unknown as PrismaService,
    { emitToWorkspace: jest.fn() } as unknown as RealtimeService,
    media as unknown as MediaService,
    client as unknown as ZernioClient,
    { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
    { ask: jest.fn() } as never,
    { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
  );
  return { svc, client };
}

const publish = (svc: ZernioService, input: Record<string, unknown>) =>
  svc.publish(
    WS,
    { content: "hello", platforms: ["instagram", "facebook"], ...input } as never,
    "https://app.test",
  );

describe("ZernioService.publish — Instagram options", () => {
  it("puts the options on Instagram's platform entry only", async () => {
    // Sending Instagram keys to Facebook's entry is the kind of mistake that
    // either errors confusingly or, worse, is silently ignored.
    const { svc, client } = build();
    await publish(svc, { mediaIds: ["m1"], instagram: { isAiGenerated: true } });

    const body = client.createPost.mock.calls[0][0];
    const ig = body.platforms.find((p: any) => p.platform === "instagram");
    const fb = body.platforms.find((p: any) => p.platform === "facebook");
    expect(ig.platformSpecificData).toEqual({ isAiGenerated: true });
    expect(fb.platformSpecificData).toBeUndefined();
  });

  it("sends no platformSpecificData when no options were given", async () => {
    const { svc, client } = build();
    await publish(svc, { mediaIds: ["m1"] });
    const body = client.createPost.mock.calls[0][0];
    expect(body.platforms.every((p: any) => p.platformSpecificData === undefined)).toBe(true);
  });

  describe("media shape", () => {
    // `mediaItems` is the only media field POST /posts accepts. The flat
    // `mediaUrls` array this used to send is not in that schema — it belongs
    // to the Ads and SMS bodies — so Zernio dropped it and the post arrived
    // with no media at all. Instagram rejected those outright; Facebook would
    // have published the caption by itself. Confirmed live 2026-11-26.
    it("never sends mediaUrls, which POST /posts does not accept", async () => {
      const { svc, client } = build();
      await publish(svc, { mediaIds: ["m1", "m2"] });
      expect(client.createPost.mock.calls[0][0].mediaUrls).toBeUndefined();
    });

    it("attaches every item as mediaItems, with no alt text needed", async () => {
      const { svc, client } = build();
      await publish(svc, { mediaIds: ["m1", "m2"] });
      expect(client.createPost.mock.calls[0][0].mediaItems).toEqual([
        { url: "https://cdn.test/m1.jpg", type: "image", mimeType: "image/jpeg", filename: "m1.jpg" },
        { url: "https://cdn.test/m2.jpg", type: "image", mimeType: "image/jpeg", filename: "m2.jpg" },
      ]);
    });

    it("names the kind, because our URLs carry no file extension", async () => {
      // `/api/media/<id>/public?token=…` and the signed Spaces link both end
      // without one, so Zernio has nothing to infer image-vs-video from.
      const { svc, client } = build();
      await publish(svc, { mediaIds: ["v1"] });
      expect(client.createPost.mock.calls[0][0].mediaItems[0]).toMatchObject({
        type: "video",
        mimeType: "video/mp4",
      });
    });

    it("carries alt text on the item it belongs to", async () => {
      const { svc, client } = build();
      await publish(svc, { mediaIds: ["m1", "m2"], altTexts: ["", "a cup of coffee"] });
      const items = client.createPost.mock.calls[0][0].mediaItems;
      expect(items[0].altText).toBeUndefined();
      expect(items[1].altText).toBe("a cup of coffee");
    });

    it("ignores whitespace-only alt text", async () => {
      const { svc, client } = build();
      await publish(svc, { mediaIds: ["m1"], altTexts: ["   "] });
      const items = client.createPost.mock.calls[0][0].mediaItems;
      expect(items).toHaveLength(1);
      expect(items[0].altText).toBeUndefined();
    });
  });

  it("refuses an impossible combination before anything is created", async () => {
    // A Story with collaborators is rejected by Instagram. Failing here means
    // the user can fix it; failing downstream means a scheduled post that
    // silently never appears.
    const { svc, client } = build();
    await expect(
      publish(svc, {
        mediaIds: ["m1"],
        instagram: { contentType: "story", collaborators: ["someone"] },
      }),
    ).rejects.toThrow(/Stories cannot take collaborators/i);
    expect(client.createPost).not.toHaveBeenCalled();
  });

  it("counts the real media when validating", async () => {
    // The carousel/Reel distinction is media count, so validation has to see
    // the resolved list rather than trust the caller.
    const { svc, client } = build();
    await expect(
      publish(svc, { mediaIds: ["m1", "m2"], instagram: { shareToFeed: false } }),
    ).rejects.toThrow(/carousel/i);
    expect(client.createPost).not.toHaveBeenCalled();
  });
});
