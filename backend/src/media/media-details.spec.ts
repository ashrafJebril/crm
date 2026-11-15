import { BadRequestException } from "@nestjs/common";
import {
  AGENT_PHOTO_MAX_BYTES,
  AGENT_PHOTO_MIMES,
  AGENT_PHOTO_URL_TTL_S,
  approvalBlock,
  isAgentPhoto,
  normalizeDetails,
  normalizeTags,
  searchTokens,
} from "./media-details";
import { HEADER_LIMITS } from "../integrations/template-header";

const MB = 1024 * 1024;

describe("media details (pure)", () => {
  it("shares the 5 MB image limit with template headers and allows only JPEG/PNG", () => {
    expect(AGENT_PHOTO_MAX_BYTES).toBe(HEADER_LIMITS.image);
    expect(AGENT_PHOTO_MAX_BYTES).toBe(5 * MB);
    expect([...AGENT_PHOTO_MIMES]).toEqual(["image/jpeg", "image/png"]);
    expect(AGENT_PHOTO_URL_TTL_S).toBe(86400);
  });

  it("normalizeTags trims, lowercases Latin, keeps Arabic and drops empties and duplicates", () => {
    expect(normalizeTags(["Menu", " menu ", "", "قائمة", "MENU"])).toEqual(["menu", "قائمة"]);
    expect(normalizeTags(["  ", "A b"])).toEqual(["a b"]);
    expect(normalizeTags(null)).toEqual([]);
  });

  it("normalizeTags refuses more than 20 tags after normalisation (class-validator shaped 400)", () => {
    const tags = Array.from({ length: 21 }, (_, i) => `t${i}`);
    let err: any;
    try {
      normalizeTags(tags);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ statusCode: 400, error: "Bad Request" });
    expect(Array.isArray(err.getResponse().message)).toBe(true);
    // 21 raw tags that collapse to 20 are fine.
    expect(normalizeTags([...tags.slice(0, 20), "T0"])).toHaveLength(20);
  });

  it("normalizeDetails: '' clears to null, absent fields are untouched, text is trimmed", () => {
    expect(normalizeDetails({})).toEqual({});
    expect(normalizeDetails({ title: "  Menu  ", alt: "", useWhen: null })).toEqual({
      title: "Menu",
      alt: null,
      useWhen: null,
    });
    expect(normalizeDetails({ tags: ["A"], approvedForAgent: false })).toEqual({ tags: ["a"], approvedForAgent: false });
    expect("title" in normalizeDetails({ alt: "x" })).toBe(false);
  });

  it("normalizeDetails enforces the limits after trimming", () => {
    expect(normalizeDetails({ title: ` ${"a".repeat(120)} ` }).title).toHaveLength(120);
    expect(() => normalizeDetails({ title: "a".repeat(121) })).toThrow(BadRequestException);
    expect(() => normalizeDetails({ alt: "a".repeat(501) })).toThrow(BadRequestException);
    expect(() => normalizeDetails({ useWhen: "a".repeat(501) })).toThrow(BadRequestException);
  });

  it("approvalBlock: type, then size, then inbound", () => {
    const staff = { uploadedById: "u1", sizeBytes: 4 * MB };
    for (const mimeType of ["application/pdf", "video/mp4", "image/webp", "image/gif"]) {
      expect(approvalBlock({ ...staff, mimeType })).toBe("type");
    }
    expect(approvalBlock({ ...staff, mimeType: "image/png", sizeBytes: 6 * MB })).toBe("size");
    expect(approvalBlock({ mimeType: "image/jpeg", sizeBytes: MB, uploadedById: null })).toBe("inbound");
    expect(approvalBlock({ ...staff, mimeType: "image/jpeg" })).toBeNull();
    expect(approvalBlock({ ...staff, mimeType: "image/png", sizeBytes: 5 * MB })).toBeNull();
  });

  it("isAgentPhoto needs approval, a photo type and the size cap", () => {
    const ok = { approvedForAgent: true, mimeType: "image/jpeg", sizeBytes: MB };
    expect(isAgentPhoto(ok)).toBe(true);
    expect(isAgentPhoto({ ...ok, approvedForAgent: false })).toBe(false);
    expect(isAgentPhoto({ ...ok, mimeType: "image/webp" })).toBe(false);
    expect(isAgentPhoto({ ...ok, sizeBytes: 6 * MB })).toBe(false);
  });

  it("searchTokens splits on whitespace and keeps at most 5", () => {
    expect(searchTokens("  red   menu ")).toEqual(["red", "menu"]);
    expect(searchTokens("a b c d e f g")).toEqual(["a", "b", "c", "d", "e"]);
    expect(searchTokens("")).toEqual([]);
    expect(searchTokens(undefined)).toEqual([]);
    expect(searchTokens("قائمة الطعام")).toEqual(["قائمة", "الطعام"]);
  });
});
