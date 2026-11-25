import { HttpException } from "@nestjs/common";
import { brandInk, contrastRatio, INK_DARK, INK_LIGHT, normalizeBrandColor, safeBrandColor } from "./brand-color";
import { BRAND_COLOR_RE, DEFAULT_CHAT_COLOR, LOGO_MAX_BYTES, LOGO_TYPES, logoPath } from "./brand-constants";

const keyOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return { status: (e as HttpException).getStatus(), body: (e as HttpException).getResponse() };
  }
  return null;
};

/** Shared with the frontend mirror (src/lib/brandColor.ts): input → [normalised, ink]. */
export const BRAND_FIXTURES: [string, string, string][] = [
  ["#ffffff", "#ffffff", INK_DARK],
  ["#000000", "#000000", INK_LIGHT],
  ["#c9a55a", "#c9a55a", INK_DARK],
  ["#5B2D8E", "#5b2d8e", INK_LIGHT],
  ["#ffff00", "#ffff00", INK_DARK],
  ["#ABC", "#aabbcc", INK_DARK],
  ["#111827", "#111827", INK_LIGHT],
  ["#0ea5e9", "#0ea5e9", INK_DARK],
];

describe("brand colour", () => {
  it("brand colour normalised and validated", () => {
    expect(normalizeBrandColor("#ABC")).toBe("#aabbcc");
    expect(normalizeBrandColor(" #AbCdEf ")).toBe("#abcdef");
    expect(normalizeBrandColor(null)).toBeNull();
    expect(normalizeBrandColor("")).toBeNull();
    for (const bad of ["red", "#12345", "#gggggg", "abc", "#abcd", "#1234567", "url(x)", "#fff;}body{", 123, {}]) {
      expect({ bad, r: keyOf(() => normalizeBrandColor(bad)) }).toEqual({ bad, r: { status: 400, body: { statusCode: 400, message: "workspaces.invalid_brand_color" } } });
    }
    // A bad stored value is never emitted.
    expect(safeBrandColor("expression(alert(1))")).toBeNull();
    expect(safeBrandColor("#ABCDEF")).toBe("#abcdef");
  });

  it("brand ink picks the higher-contrast text colour", () => {
    for (const [input, norm, ink] of BRAND_FIXTURES) {
      expect({ input, norm: normalizeBrandColor(input), ink: brandInk(input) }).toEqual({ input, norm, ink });
      const chosen = contrastRatio(norm, ink);
      const other = contrastRatio(norm, ink === INK_LIGHT ? INK_DARK : INK_LIGHT);
      expect(chosen).toBeGreaterThanOrEqual(other);
      expect(chosen).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });

  it("constants", () => {
    expect([...LOGO_TYPES]).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(LOGO_MAX_BYTES).toBe(2097152);
    expect(BRAND_COLOR_RE.test("#ABC")).toBe(true);
    expect(DEFAULT_CHAT_COLOR).toBe("#111827");
    expect(logoPath("ws 1", "m/1")).toBe("/api/branding/ws%201/logo/m%2F1");
  });
});
