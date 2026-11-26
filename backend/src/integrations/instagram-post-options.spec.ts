import { BadRequestException } from "@nestjs/common";
import {
  assertInstagramOptions,
  instagramPlatformData,
  type InstagramOptions,
} from "./instagram-post-options";

/**
 * Instagram publishing options.
 *
 * The validation exists because of WHEN Instagram rejects things. A refused
 * publish comes back as a generic per-platform `errorMessage` long after the
 * composer is closed — and for a scheduled post, hours later, when nobody is
 * watching. Catching the combination at submit, and naming the option, is the
 * difference between a fixable mistake and a post that silently never appears.
 */
const opts = (over: Partial<InstagramOptions> = {}): InstagramOptions => ({ ...over });

describe("assertInstagramOptions", () => {
  describe("stories", () => {
    it.each([
      ["locationId", { locationId: "123" }],
      ["collaborators", { collaborators: ["someone"] }],
      ["audioConfiguration", { audioConfiguration: { audioId: "a1" } }],
      ["trialParams", { trialParams: { graduationStrategy: "MANUAL" as const } }],
      ["firstComment", { firstComment: "link here" }],
    ])("rejects %s on a Story", (_label, extra) => {
      expect(() =>
        assertInstagramOptions(opts({ contentType: "story", ...extra }), 1),
      ).toThrow(BadRequestException);
    });

    it("rejects more than one item on a Story", () => {
      expect(() => assertInstagramOptions(opts({ contentType: "story" }), 3)).toThrow(
        /single photo or video/i,
      );
    });

    it("allows a plain Story", () => {
      expect(() =>
        assertInstagramOptions(opts({ contentType: "story", isAiGenerated: true }), 1),
      ).not.toThrow();
    });
  });

  describe("carousels", () => {
    it.each([
      ["audioConfiguration", { audioConfiguration: { audioId: "a1" } }],
      ["shareToFeed", { shareToFeed: false }],
      ["trialParams", { trialParams: { graduationStrategy: "SS_PERFORMANCE" as const } }],
      ["thumbOffset", { thumbOffset: 1000 }],
    ])("rejects the Reel-only option %s", (_label, extra) => {
      expect(() => assertInstagramOptions(opts(extra), 4)).toThrow(/carousel/i);
    });

    it("rejects more than 20 items", () => {
      // 20, not the 10 the product spec assumed — Zernio's documented cap.
      expect(() => assertInstagramOptions(opts(), 21)).toThrow(/at most 20/i);
      expect(() => assertInstagramOptions(opts(), 20)).not.toThrow();
    });
  });

  it("rejects more than 3 collaborators", () => {
    expect(() => assertInstagramOptions(opts({ collaborators: ["a", "b", "c", "d"] }), 1)).toThrow(
      /at most 3 collaborators/i,
    );
  });

  it("rejects both cover kinds at once", () => {
    // Zernio silently prefers the image; saying so beats letting someone
    // wonder why their chosen frame was ignored.
    expect(() =>
      assertInstagramOptions(
        opts({ thumbOffset: 500, instagramThumbnail: "https://x.test/c.jpg" }),
        1,
      ),
    ).toThrow(/cover image or a cover frame/i);
  });

  describe("user tags", () => {
    it("rejects half a coordinate pair", () => {
      expect(() =>
        assertInstagramOptions(opts({ userTags: [{ username: "ada", x: 0.5 }] }), 1),
      ).toThrow(/both x and y/i);
    });

    it("rejects a tag pointing past the last slide", () => {
      expect(() =>
        assertInstagramOptions(opts({ userTags: [{ username: "ada", mediaIndex: 3 }] }), 2),
      ).toThrow(/isn't in this post/i);
    });

    it("allows a tag with no coordinates (video and Reels ignore them)", () => {
      expect(() =>
        assertInstagramOptions(opts({ userTags: [{ username: "ada" }] }), 1),
      ).not.toThrow();
    });
  });
});

describe("instagramPlatformData", () => {
  it("sends only what was set", () => {
    // Zernio reads a PRESENT key as a decision, so an undefined one must not
    // be sent at all — `commentsEnabled: undefined` is not "leave it alone".
    const out = instagramPlatformData(opts({ isAiGenerated: true }));
    expect(out).toEqual({ isAiGenerated: true });
    expect("commentsEnabled" in out).toBe(false);
  });

  it("keeps thumbOffset 0, which is a real choice", () => {
    // The first frame. A falsy-dropping serializer would quietly lose it.
    expect(instagramPlatformData(opts({ thumbOffset: 0 }))).toEqual({ thumbOffset: 0 });
  });

  it("keeps commentsEnabled false", () => {
    expect(instagramPlatformData(opts({ commentsEnabled: false }))).toEqual({
      commentsEnabled: false,
    });
  });

  it("strips a leading @ from tagged usernames", () => {
    const out = instagramPlatformData(opts({ userTags: [{ username: "@ada", x: 0.1, y: 0.2 }] }));
    expect(out.userTags).toEqual([{ username: "ada", x: 0.1, y: 0.2 }]);
  });

  it("drops an empty collaborator list rather than sending []", () => {
    expect(instagramPlatformData(opts({ collaborators: [] }))).toEqual({});
  });

  it("passes the documented option names through unchanged", () => {
    // These are ZERNIO's names, not Meta's. Renaming any of them to the Graph
    // spelling the product spec used would silently stop it working.
    const out = instagramPlatformData(
      opts({
        contentType: "story",
        locationId: "1058724220665775",
        isAiGenerated: true,
        audioConfiguration: { audioId: "a1", audioVolume: 80, videoVolume: 0 },
        audioName: "Kewy theme",
        shareToFeed: false,
        trialParams: { graduationStrategy: "SS_PERFORMANCE" },
        instagramThumbnail: "https://x.test/cover.jpg",
        commentsEnabled: false,
        firstComment: "kewy.ai",
        muteAudio: true,
      }),
    );
    expect(Object.keys(out).sort()).toEqual(
      [
        "audioConfiguration",
        "audioName",
        "commentsEnabled",
        "contentType",
        "firstComment",
        "instagramThumbnail",
        "isAiGenerated",
        "locationId",
        "muteAudio",
        "shareToFeed",
        "trialParams",
      ].sort(),
    );
  });
});
