import { describe, it, expect } from "vitest";
import { capability, mediaLimits, visibleOptions } from "./capabilities";

/**
 * These tests are the record of what Zernio's OpenAPI schema actually says,
 * because the two product specs and Zernio's own prose docs both got parts of
 * it wrong. If someone later "fixes" one of these to match a spec, the test
 * should make them check the schema first.
 */
describe("capabilities", () => {
  describe("corrections to the product specs", () => {
    it("Facebook CAN alt-text a feed photo", () => {
      // Spec filed this under Graph's alt_text_custom and the docs omit it;
      // it is MediaItem.altText, shared across platforms.
      expect(capability("facebook", "post", "altText").supported).toBe(true);
    });

    it("Facebook CAN take SRT subtitles", () => {
      // MediaItem.subtitles — every track, up to 200 KB each.
      expect(capability("facebook", "post", "subtitles").supported).toBe(true);
      expect(capability("facebook", "reel", "subtitles").supported).toBe(true);
    });

    it("Facebook CAN set a Reel or video cover", () => {
      expect(capability("facebook", "reel", "cover").supported).toBe(true);
    });

    it("Facebook AI label is Reels and video Stories only, not feed posts", () => {
      // The schema accepts the flag on a feed post "with a warning and no
      // label" — so offering it there would promise a badge that never shows.
      expect(capability("facebook", "reel", "aiLabel").supported).toBe(true);
      expect(capability("facebook", "story", "aiLabel").supported).toBe(true);
      const feed = capability("facebook", "post", "aiLabel");
      expect(feed.supported).toBe(false);
      expect(feed.reason).toMatch(/Reels and video Stories/i);
    });
  });

  describe("what genuinely cannot be done", () => {
    it.each(["poll", "commentPrompt", "ctaButton"] as const)("%s on any platform", (opt) => {
      for (const p of ["instagram", "facebook"] as const) {
        for (const k of ["post", "reel", "story"] as const) {
          expect(capability(p, k, opt).supported).toBe(false);
        }
      }
    });

    it("explains why, rather than just hiding the control", () => {
      expect(capability("instagram", "post", "poll").reason).toMatch(/not forwarded/i);
      expect(capability("facebook", "post", "location").reason).toMatch(/does not expose/i);
    });

    it("Facebook has no location or people-tagging", () => {
      expect(capability("facebook", "post", "location").supported).toBe(false);
      expect(capability("facebook", "post", "tagPeople").supported).toBe(false);
      // Instagram does have both — the asymmetry is real, not an oversight.
      expect(capability("instagram", "post", "location").supported).toBe(true);
      expect(capability("instagram", "post", "tagPeople").supported).toBe(true);
    });
  });

  describe("stories are the most restricted everywhere", () => {
    it.each([
      ["instagram", "caption"],
      ["instagram", "collaborators"],
      ["instagram", "commentsOff"],
      ["facebook", "caption"],
      ["facebook", "geoRestriction"],
      ["facebook", "nativeDraft"],
    ] as const)("%s story has no %s", (platform, option) => {
      expect(capability(platform, "story", option).supported).toBe(false);
    });
  });

  describe("Instagram Reel-only options", () => {
    it.each(["audioTrack", "audioName", "shareToFeed", "trialReel", "cover"] as const)(
      "%s is Reels only",
      (opt) => {
        expect(capability("instagram", "reel", opt).supported).toBe(true);
        expect(capability("instagram", "post", opt).supported).toBe(false);
        expect(capability("instagram", "story", opt).supported).toBe(false);
      },
    );

    it("alt text is the opposite — feed images only", () => {
      expect(capability("instagram", "post", "altText").supported).toBe(true);
      expect(capability("instagram", "reel", "altText").supported).toBe(false);
      expect(capability("instagram", "story", "altText").supported).toBe(false);
    });
  });

  describe("media limits", () => {
    it("Instagram carousels take 20, not the 10 the spec assumed", () => {
      expect(mediaLimits("instagram", "post").max).toBe(20);
    });

    it("Facebook takes the lower of its two conflicting documented limits", () => {
      expect(mediaLimits("facebook", "post").max).toBe(10);
    });

    it.each(["reel", "story"] as const)("%s is a single item", (kind) => {
      expect(mediaLimits("instagram", kind)).toEqual({ min: 1, max: 1 });
      expect(mediaLimits("facebook", kind)).toEqual({ min: 1, max: 1 });
    });
  });

  describe("visibleOptions drives the Details step", () => {
    it("never lists something unsupported", () => {
      for (const p of ["instagram", "facebook"] as const) {
        for (const k of ["post", "reel", "story"] as const) {
          for (const opt of visibleOptions(p, k)) {
            expect(capability(p, k, opt).supported).toBe(true);
          }
        }
      }
    });

    it("gives a Facebook feed post fewer options than an Instagram one", () => {
      // Worth asserting: it is the visible consequence of the asymmetry, and
      // someone will otherwise report it as a bug.
      expect(visibleOptions("facebook", "post").length).toBeLessThan(
        visibleOptions("instagram", "post").length,
      );
    });

    it("leaves an Instagram story with very little", () => {
      expect(visibleOptions("instagram", "story")).toEqual(["tagPeople", "aiLabel"]);
    });
  });
});
