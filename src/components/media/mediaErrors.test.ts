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
  // SP-17
  "media.no_changes",
  "media.not_approvable",
  "media.title_required",
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

  it("SP-09: media.in_use lists the tickets that hold the file", () => {
    const only = new ApiError("media.in_use", 409, undefined, {
      message: "media.in_use",
      templates: [],
      campaigns: [],
      tickets: [{ id: "t1", number: 7, pipelineId: "p1" }, { id: "t2", number: 12, pipelineId: "p1" }],
    });
    expect(mediaErrorText(only, en)).toBe(
      "This file is attached to tickets #7 and #12, so it can't be deleted. Remove it from those first.",
    );
    expect(mediaErrorText(only, ar)).toMatch(ARABIC);
    expect(mediaErrorText(only, ar)).toContain("#7");
    const mixed = new ApiError("media.in_use", 409, undefined, {
      message: "media.in_use",
      templates: [{ id: "x", name: "promo_header" }],
      campaigns: [],
      tickets: [{ id: "t1", number: 3, pipelineId: "p1" }],
    });
    expect(mediaErrorText(mixed, en)).toBe(
      "This file is used by template “promo_header” and ticket #3, so it can't be deleted. Change those first.",
    );
    const many = new ApiError("media.in_use", 409, undefined, {
      message: "media.in_use",
      templates: [],
      campaigns: [],
      tickets: [1, 2, 3, 4].map((n) => ({ id: `t${n}`, number: n, pipelineId: "p" })),
    });
    expect(mediaErrorText(many, en)).toContain("tickets #1, #2 and 2 more");
    // Empty lists keep the plain fallback.
    const none = new ApiError("media.in_use", 409, undefined, { message: "media.in_use", templates: [], campaigns: [], tickets: [] });
    expect(mediaErrorText(none, en)).toContain("can't be deleted");
  });

  it("falls back for unknown errors and words a 403", () => {
    expect(mediaErrorText(new ApiError("Missing permission", 403), en)).toBe("You don't have permission to do this");
    expect(mediaErrorText(new Error("HTTP 500"), en, "Upload failed")).toBe("Upload failed");
    expect(mediaErrorText(new Error("boom"), ar)).toMatch(ARABIC);
  });
});

describe("SP-17 media keys", () => {
  it("media error copy covers the SP-17 keys in both languages", () => {
    const err = (key: string, extra: Record<string, unknown> = {}) =>
      new ApiError(key, 400, undefined, { statusCode: 400, message: key, ...extra });
    const cases: Array<[ApiError, string]> = [
      [err("media.no_changes"), "Nothing changed."],
      [err("media.not_approvable", { reason: "type" }), "Only JPG or PNG photos can be sent by the agent."],
      [err("media.not_approvable", { reason: "size" }), "Photos larger than 5 MB can't be sent by the agent."],
      [err("media.not_approvable", { reason: "inbound" }), "Customer attachments can't be approved for the agent."],
      [err("media.not_approvable"), "This file can't be approved for the agent."],
      [err("media.title_required"), "Add a title before approving this photo for the agent."],
      [err("media.invalid_query", { param: "q" }), "Search is too long. Use at most 100 characters."],
      [err("media.invalid_query", { param: "approved" }), "The approval filter is not valid. Refresh and try again."],
      [err("media.invalid_query", { param: "before" }), "The file list couldn't be loaded. Refresh and try again."],
    ];
    const arabic = new Set<string>();
    for (const [e, text] of cases) {
      expect(mediaErrorText(e, en)).toBe(text);
      const a = mediaErrorText(e, ar);
      expect(a, e.message).toMatch(ARABIC);
      arabic.add(a);
    }
    // Each case has its own Arabic copy.
    expect(arabic.size).toBe(cases.length);
    expect(mediaErrorText(err("media.not_approvable", { reason: "size" }), ar)).toContain("5");
  });
});
