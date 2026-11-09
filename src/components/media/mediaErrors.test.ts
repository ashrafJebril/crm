import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import { MEDIA_ERROR_COPY, mediaErrorText } from "./mediaErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

// Every key in backend media-errors.ts and the template-header keys (task-3 report, fix round 1).
const KEYS = [
  "media.no_file",
  "media.unsupported_type",
  "media.too_large",
  "media.type_mismatch",
  "media.invalid_query",
  "media.in_use",
  "Media not found",
  "templates.header_media_too_large",
  "templates.header_media_mismatch",
  "templates.header_media_required",
];

describe("mediaErrorText", () => {
  it("maps every media and header key to copy in both languages", () => {
    expect(Object.keys(MEDIA_ERROR_COPY).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) {
      const err = new ApiError(key, 400, undefined, { statusCode: 400, message: key });
      const e = mediaErrorText(err, en);
      const a = mediaErrorText(err, ar);
      expect(e, key).not.toBe(key);
      expect(e, key).not.toMatch(ARABIC);
      expect(a, key).toMatch(ARABIC);
    }
  });

  it("reads limit, allowed and in-use extras", () => {
    const tooLarge = new ApiError("media.too_large", 400, undefined, { message: "media.too_large", limit: 20 * 1024 * 1024 });
    expect(mediaErrorText(tooLarge, en)).toBe("That file is too large. The limit for this type is 20 MB.");
    expect(mediaErrorText(tooLarge, ar)).toContain("20 MB");
    const header = new ApiError("templates.header_media_too_large", 400, undefined, { message: "x", limit: 5242880 });
    expect(mediaErrorText(header, en)).toBe("That file is larger than WhatsApp's 5 MB header limit.");
    const type = new ApiError("media.unsupported_type", 400, undefined, {
      message: "media.unsupported_type",
      allowed: ["image/jpeg", "image/png", "application/pdf"],
    });
    expect(mediaErrorText(type, en)).toBe("That file type isn't supported. Use JPG, PNG, PDF.");
    const inUse = new ApiError("media.in_use", 409, undefined, {
      message: "media.in_use",
      templates: [{ id: "t1", name: "promo_header" }],
      campaigns: [{ id: "c1", name: "Eid offer", status: "scheduled" }],
    });
    expect(mediaErrorText(inUse, en)).toBe(
      "This file is used by template “promo_header” and campaign “Eid offer”, so it can't be deleted. Change those first.",
    );
    expect(mediaErrorText(inUse, ar)).toMatch(ARABIC);
    expect(mediaErrorText(inUse, ar)).toContain("promo_header");
  });

  it("falls back for unknown errors and words a 403", () => {
    expect(mediaErrorText(new ApiError("Missing permission", 403), en)).toBe("You don't have permission to do this");
    expect(mediaErrorText(new Error("HTTP 500"), en, "Upload failed")).toBe("Upload failed");
    expect(mediaErrorText(new Error("boom"), ar)).toMatch(ARABIC);
  });
});
