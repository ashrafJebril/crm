import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import type { Media } from "@/lib/types";
import {
  HEADER_LIMITS,
  MEDIA_CATEGORIES,
  flattenMediaPages,
  formatBytes,
  headerIneligibleReason,
  headerKind,
  kindOfMime,
  mediaFitsHeader,
  mediaMatchesHeader,
  mediaPagePath,
  nextMediaCursor,
  parseMediaPage,
} from "./mediaKinds";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;
const MB = 1024 * 1024;

const file = (id: string, mimeType: string, sizeBytes = 1000): Media => ({
  id,
  workspaceId: "w",
  fileName: `${id}.bin`,
  mimeType,
  sizeBytes,
  storedPath: "",
  width: null,
  height: null,
  uploadedById: null,
  createdAt: "2026-11-01T00:00:00Z",
});

describe("mediaKinds", () => {
  it("mediaMatchesHeader enforces WhatsApp header limits", () => {
    // Types: JPG/PNG, MP4, PDF only.
    expect(mediaMatchesHeader(file("a", "image/jpeg"), "image")).toBe(true);
    expect(mediaMatchesHeader(file("a", "image/png"), "image")).toBe(true);
    expect(mediaMatchesHeader(file("a", "image/webp"), "image")).toBe(false);
    expect(mediaMatchesHeader(file("a", "image/gif"), "image")).toBe(false);
    expect(mediaMatchesHeader(file("a", "video/mp4"), "video")).toBe(true);
    expect(mediaMatchesHeader(file("a", "video/quicktime"), "video")).toBe(false);
    expect(mediaMatchesHeader(file("a", "application/pdf"), "document")).toBe(true);
    expect(mediaMatchesHeader(file("a", "application/pdf"), "image")).toBe(false);
    expect(mediaMatchesHeader(file("a", "image/png"), "text")).toBe(false);

    // Sizes: 5 MB, 16 MB, 100 MB, the backend's HEADER_LIMITS.
    expect(HEADER_LIMITS).toEqual({ image: 5242880, video: 16 * MB, document: 100 * MB });
    expect(mediaFitsHeader(file("a", "image/png", 5 * MB), "image")).toBe(true);
    expect(mediaFitsHeader(file("a", "image/png", 5 * MB + 1), "image")).toBe(false);
    expect(mediaFitsHeader(file("a", "video/mp4", 16 * MB + 1), "video")).toBe(false);
    expect(mediaFitsHeader(file("a", "application/pdf", 100 * MB), "document")).toBe(true);

    // The greyed-out reason names the rule in both languages.
    expect(headerIneligibleReason(file("a", "image/png", 1000), "image", en)).toBeNull();
    expect(headerIneligibleReason(file("a", "image/png", 6 * MB), "image", en)).toBe("Larger than WhatsApp's 5 MB header limit");
    expect(headerIneligibleReason(file("a", "image/png", 6 * MB), "image", ar)).toMatch(ARABIC);
    expect(headerIneligibleReason(file("a", "video/mp4", 17 * MB), "video", en)).toContain("16 MB");
    expect(headerIneligibleReason(file("a", "image/webp"), "image", en)).toBe("WhatsApp headers take JPG or PNG images only");
    expect(headerIneligibleReason(file("a", "video/quicktime"), "video", ar)).toMatch(ARABIC);
  });

  it("classifies mimes and header types", () => {
    expect(kindOfMime("image/webp")).toBe("image");
    expect(kindOfMime("video/quicktime")).toBe("video");
    expect(kindOfMime("application/pdf")).toBe("document");
    expect(kindOfMime("text/csv")).toBeNull();
    expect(headerKind({ headerType: "IMAGE" })).toBe("image");
    expect(headerKind({ headerType: "none" })).toBeNull();
    expect(headerKind(null)).toBeNull();
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
    expect(formatBytes(820 * 1024)).toBe("820 KB");
    expect(MEDIA_CATEGORIES.map((c) => c.id)).toEqual(["all", "image", "video", "document"]);
    for (const c of MEDIA_CATEGORIES) expect(c.ar).toMatch(ARABIC);
  });

  it("media paging follows the cursor header until it is absent", () => {
    expect(mediaPagePath("all", null)).toBe("/media?kind=all&limit=60");
    expect(mediaPagePath("document", "m9", 60)).toBe("/media?kind=document&limit=60&before=m9");

    // A short (even empty) page with a header is not the end: a restricted viewer's scan budget ran out.
    const p1 = parseMediaPage([file("m1", "image/png"), file("m2", "image/png")], "m2");
    const p2 = parseMediaPage([], "h039");
    expect(nextMediaCursor([p1])).toBe("m2");
    expect(nextMediaCursor([p1, p2])).toBe("h039");
    // A full page without a header is the end.
    const p3 = parseMediaPage([file("m3", "application/pdf")], null);
    expect(nextMediaCursor([p1, p2, p3])).toBeNull();
    expect(parseMediaPage([file("x", "image/png")], "  ").nextBefore).toBeNull();
    expect(parseMediaPage({ not: "an array" }, null).items).toEqual([]);
    expect(nextMediaCursor([])).toBeNull();

    // Pages concatenate in order without duplicates.
    const again = parseMediaPage([file("m2", "image/png"), file("m4", "image/png")], null);
    expect(flattenMediaPages([p1, p2, again]).map((m) => m.id)).toEqual(["m1", "m2", "m4"]);
  });
});
