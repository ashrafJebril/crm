import { NotFoundException } from "@nestjs/common";
import { makeFakePrisma } from "../channels/test-prisma";
import { ConversationsService } from "../conversations/conversations.service";
import { ChannelResolver } from "../channels/channel-resolver.service";
import { ChannelTransportRegistry } from "../channels/channel-transport";
import { MediaService } from "../media/media.service";
import { AdSourcesService, decodeCursor, encodeCursor } from "./ad-sources.service";
import { ADS_ERROR_KEYS, adsError } from "./ad-errors";
import { resolveDayRange, zonedMidnight } from "./ad-range";

const conv = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  contactId: "c1",
  channel: "whatsapp",
  channelId: null,
  pinned: false,
  assigneeId: null,
  preview: "",
  status: "human",
  updatedAt: new Date("2026-11-01"),
  ...over,
});

describe("GET /ad-sources (inbox filter options)", () => {
  it("labels by adName, then headline, then sourceId; newest first; this workspace only", async () => {
    const prisma = makeFakePrisma({
      adSource: [
        { id: "a", workspaceId: "ws1", sourceType: "ad", sourceId: "111", adName: "Named", headline: "H", lastReferredAt: new Date("2026-11-03") },
        { id: "b", workspaceId: "ws1", sourceType: "post", sourceId: "222", adName: null, headline: "Headline only", lastReferredAt: new Date("2026-11-05") },
        { id: "c", workspaceId: "ws1", sourceType: "ad", sourceId: "333", adName: null, headline: null, lastReferredAt: new Date("2026-11-04") },
        // Spend-only row (from the sync): no conversation ever started from it.
        { id: "d", workspaceId: "ws1", sourceType: "ad", sourceId: "444", adName: "Spend only", lastReferredAt: null },
        { id: "x", workspaceId: "ws2", sourceType: "ad", sourceId: "111", adName: "Foreign", lastReferredAt: new Date("2026-11-06") },
      ],
    });
    const res = await new AdSourcesService(prisma).listForFilter("ws1");
    expect(res.items).toEqual([
      { id: "b", label: "Headline only", sourceType: "post", lastReferredAt: new Date("2026-11-05") },
      { id: "c", label: "333", sourceType: "ad", lastReferredAt: new Date("2026-11-04") },
      { id: "a", label: "Named", sourceType: "ad", lastReferredAt: new Date("2026-11-03") },
    ]);
    expect(prisma.adSource.findMany.mock.calls[0][0].take).toBe(500);
  });
});

describe("conversation dto carries the ad chip", () => {
  const seed = () =>
    makeFakePrisma({
      adSource: [
        {
          id: "ad-1",
          workspaceId: "ws1",
          sourceType: "ad",
          sourceId: "1",
          headline: "Spring sale",
          adName: null,
          mediaType: "image",
          mediaUrl: "https://scontent.xx.fbcdn.net/a.jpg",
          mediaId: null,
        },
      ],
      conversation: [
        conv("cv-ad", { adSourceId: "ad-1", adReferredAt: new Date("2026-11-02"), updatedAt: new Date("2026-11-03") }),
        conv("cv-plain", { adSourceId: null, adReferredAt: null, updatedAt: new Date("2026-11-02") }),
      ],
      adReferral: [{ id: "r1", workspaceId: "ws1", adSourceId: "ad-1", conversationId: "cv-ad", ctwaClid: "secret-clid", messageId: "m1" }],
    });
  const build = (prisma: ReturnType<typeof makeFakePrisma>) =>
    new ConversationsService(
      prisma,
      { emitToWorkspace: jest.fn() } as never,
      { queueReply: jest.fn() } as never,
      undefined,
      { conversationScope: jest.fn(async () => ({})), assertConversationVisible: jest.fn() } as never,
      new ChannelResolver(prisma),
      new ChannelTransportRegistry(),
    );

  it("GET /conversations: Meta's link before re-hosting, ours after, null when unattributed; no ctwaClid", async () => {
    const prisma = seed();
    const svc = build(prisma);
    const before: any[] = await svc.list("ws1");
    const row = before.find((c) => c.id === "cv-ad");
    expect(row.adSource).toEqual({
      id: "ad-1",
      sourceId: "1",
      sourceType: "ad",
      headline: "Spring sale",
      adName: null,
      mediaType: "image",
      imageUrl: "https://scontent.xx.fbcdn.net/a.jpg",
    });
    expect(row.adSourceId).toBe("ad-1");
    expect(row.adReferredAt).toEqual(new Date("2026-11-02"));
    const plain = before.find((c) => c.id === "cv-plain");
    expect(plain.adSource).toBeNull();
    expect(plain.adSourceId).toBeNull();

    prisma.db.adSource[0].mediaId = "med-9";
    const after: any[] = await svc.list("ws1");
    expect(after.find((c) => c.id === "cv-ad").adSource.imageUrl).toBe("/api/media/med-9/file");
    expect(JSON.stringify(after)).not.toMatch(/ctwa|secret-clid/i);
    expect(prisma.conversation.findMany.mock.calls[0][0].include.adSource).toEqual({
      select: { id: true, sourceId: true, sourceType: true, headline: true, adName: true, mediaType: true, mediaId: true, mediaUrl: true },
    });
  });

  it("GET /conversations/:id carries the same chip", async () => {
    const prisma = seed();
    const svc = build(prisma);
    const one: any = await svc.get("ws1", "cv-ad");
    expect(one.adSource).toMatchObject({ id: "ad-1", sourceId: "1", imageUrl: "https://scontent.xx.fbcdn.net/a.jpg" });
    expect(one.labelIds).toEqual([]);
    expect(JSON.stringify(one)).not.toMatch(/ctwa|secret-clid/i);
    expect(((await svc.get("ws1", "cv-plain")) as any).adSource).toBeNull();
  });
});

describe("re-hosted ad creatives in the media library", () => {
  it("an assigned-only viewer can load an ad creative, but not a hidden inbound file", async () => {
    const prisma = makeFakePrisma({
      media: [
        { id: "med-ad", workspaceId: "ws1", uploadedById: null, storageKind: "spaces", storedPath: "a", mimeType: "image/png" },
        { id: "med-hidden", workspaceId: "ws1", uploadedById: null, storageKind: "spaces", storedPath: "b", mimeType: "image/png" },
      ],
      adSource: [{ id: "ad-1", workspaceId: "ws1", sourceType: "ad", sourceId: "1", mediaId: "med-ad" }],
    });
    const perm = { conversationScope: jest.fn(async () => ({ assigneeId: "me" })) };
    const media = new MediaService(prisma, { kind: "spaces", getSignedUrl: jest.fn(async () => "signed") } as never, perm as never);
    await expect(media.get("ws1", "med-ad", { userId: "me" })).resolves.toMatchObject({ id: "med-ad" });
    await expect(media.get("ws1", "med-hidden", { userId: "me" })).rejects.toThrow(NotFoundException);
  });
});

describe("ad error keys and ranges", () => {
  it("every key has its status and the key as message", () => {
    expect(ADS_ERROR_KEYS.sort()).toEqual(["ads.not_found", "ads.range_invalid"]);
    expect(adsError("ads.not_found").getStatus()).toBe(404);
    expect(adsError("ads.range_invalid", { param: "from" }).getResponse()).toEqual({ statusCode: 400, message: "ads.range_invalid", param: "from" });
  });

  it("from/to are inclusive local days; span ≤ 366; bad input is 400", () => {
    const r = resolveDayRange({ from: "2026-11-01", to: "2026-11-30" }, "Asia/Riyadh");
    expect(r.start.toISOString()).toBe("2026-10-31T21:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-11-30T21:00:00.000Z");
    const def = resolveDayRange({}, "UTC", new Date("2026-11-15T10:00:00Z"));
    expect([def.from, def.to]).toEqual(["2026-10-17", "2026-11-15"]);
    expect(resolveDayRange({ from: "2025-11-15", to: "2026-11-15" }, "UTC").from).toBe("2025-11-15");
    for (const q of [{ from: "2025-11-14", to: "2026-11-15" }, { from: "2026-11-02", to: "2026-11-01" }, { from: "2026-02-30" }, { to: "x" }]) {
      expect(() => resolveDayRange(q, "UTC")).toThrow(expect.objectContaining({ response: expect.objectContaining({ message: "ads.range_invalid" }) }));
    }
    expect(resolveDayRange({}, "Not/AZone").tz).toBe("UTC");
    // DST: midnight in New York on a DST day.
    expect(zonedMidnight("2026-03-08", "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(zonedMidnight("2026-03-09", "America/New_York").toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("cursors round-trip and junk decodes to null", () => {
    const at = new Date("2026-11-15T09:00:00.000Z");
    expect(decodeCursor(encodeCursor({ referredAt: at, id: "r1" }))).toEqual({ at, id: "r1" });
    expect(decodeCursor("%%%")).toBeNull();
    expect(decodeCursor(Buffer.from("nope").toString("base64url"))).toBeNull();
  });
});
