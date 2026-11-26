import { BadRequestException } from "@nestjs/common";
import {
  assertFacebookOptions,
  facebookPlatformData,
  type FacebookOptions,
} from "./facebook-post-options";

/**
 * Facebook Page options.
 *
 * Every rule here comes from Zernio's OpenAPI `FacebookPlatformData` schema
 * rather than the prose docs, which disagreed with it more than once — notably
 * on `isAiGenerated`, which the docs omit entirely and the schema supports.
 */
const opts = (over: Partial<FacebookOptions> = {}): FacebookOptions => ({ ...over });

describe("assertFacebookOptions", () => {
  it.each([
    ["a Reel title", { title: "Launch" }],
    ["collaborators", { collaborators: ["123"] }],
  ])("rejects %s on a non-Reel", (_l, extra) => {
    expect(() => assertFacebookOptions(opts(extra), 1)).toThrow(/Reels only/i);
    expect(() =>
      assertFacebookOptions(opts({ contentType: "reel", ...extra }), 1),
    ).not.toThrow();
  });

  describe("stories", () => {
    it("rejects a first comment", () => {
      expect(() =>
        assertFacebookOptions(opts({ contentType: "story", firstComment: "hi" }), 1),
      ).toThrow(BadRequestException);
    });

    it("rejects geo-restriction, which Stories do not support", () => {
      expect(() =>
        assertFacebookOptions(
          opts({ contentType: "story", geoRestriction: { countries: ["JO"] } }),
          1,
        ),
      ).toThrow(/geo-restricted/i);
    });

    it("rejects more than one item", () => {
      expect(() => assertFacebookOptions(opts({ contentType: "story" }), 2)).toThrow(
        /single photo or video/i,
      );
    });
  });

  describe("collaborators", () => {
    it("rejects a username, since Facebook needs numeric Page IDs", () => {
      // The schema says non-numeric values are ignored with a warning — so a
      // username would silently invite nobody. Better to say so.
      expect(() =>
        assertFacebookOptions(opts({ contentType: "reel", collaborators: ["@kewy"] }), 1),
      ).toThrow(/numeric Page IDs/i);
    });

    it("rejects more than 10", () => {
      const many = Array.from({ length: 11 }, (_, i) => String(i + 1));
      expect(() =>
        assertFacebookOptions(opts({ contentType: "reel", collaborators: many }), 1),
      ).toThrow(/at most 10/i);
    });
  });

  describe("geo restriction", () => {
    it("rejects a non ISO-3166 code", () => {
      expect(() =>
        assertFacebookOptions(opts({ geoRestriction: { countries: ["Jordan"] } }), 1),
      ).toThrow(/2-letter country code/i);
    });

    it("rejects an empty list", () => {
      expect(() => assertFacebookOptions(opts({ geoRestriction: { countries: [] } }), 1)).toThrow(
        /at least one country/i,
      );
    });

    it("rejects more than 25", () => {
      const many = Array.from({ length: 26 }, () => "US");
      expect(() => assertFacebookOptions(opts({ geoRestriction: { countries: many } }), 1)).toThrow(
        /at most 25/i,
      );
    });
  });
});

describe("facebookPlatformData", () => {
  it("nests draft under facebookSettings, as the schema has it", () => {
    expect(facebookPlatformData(opts({ draft: true }))).toEqual({
      facebookSettings: { draft: true },
    });
  });

  it("keeps isAiGenerated false rather than dropping it", () => {
    expect(facebookPlatformData(opts({ isAiGenerated: false }))).toEqual({
      isAiGenerated: false,
    });
  });

  it("sends only what was set", () => {
    const out = facebookPlatformData(opts({ contentType: "reel", title: "Launch" }));
    expect(out).toEqual({ contentType: "reel", title: "Launch" });
  });

  it("drops an empty country list rather than sending an invalid one", () => {
    expect(facebookPlatformData(opts({ geoRestriction: { countries: [] } }))).toEqual({});
  });
});
