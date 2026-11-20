import { describe, expect, it } from "vitest";
// The backend file is the fixture (read as text; never compiled here).
import backendConstants from "../../../backend/src/workspaces/brand-constants.ts?raw";
import { makeTx } from "@/lib/tx";
import { ApiError } from "@/api/client";
import { brandErrorText, DEFAULT_CHAT_COLOR, logoCheckError, LOGO_MAX_BYTES, LOGO_TYPES, SAVED_FLASH_MS, validateLogoFile } from "./brand";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

describe("logo file validated before upload", () => {
  it("mirrors the backend constants", () => {
    expect(backendConstants).toContain(`LOGO_TYPES = [${LOGO_TYPES.map((t) => `"${t}"`).join(", ")}]`);
    expect(backendConstants).toContain("LOGO_MAX_BYTES = 2 * 1024 * 1024");
    expect(LOGO_MAX_BYTES).toBe(2097152);
    expect(backendConstants).toContain(`DEFAULT_CHAT_COLOR = "${DEFAULT_CHAT_COLOR}"`);
    expect(backendConstants).toContain(`SAVED_FLASH_MS = ${SAVED_FLASH_MS}`);
  });

  it("type, the 2 MB boundary and the SVG refusal, with the backend keys", () => {
    expect(validateLogoFile({ name: "logo.png", type: "image/png", size: 10 * 1024 })).toBeNull();
    expect(validateLogoFile({ name: "logo.JPG", type: "image/jpeg", size: 1 })).toBeNull();
    expect(validateLogoFile({ name: "logo.webp", type: "image/webp", size: LOGO_MAX_BYTES })).toBeNull();
    expect(validateLogoFile({ name: "logo.png", type: "image/png", size: LOGO_MAX_BYTES + 1 })).toEqual({ key: "media.too_large", extra: { limit: 2097152 } });
    for (const f of [
      { name: "logo.svg", type: "image/svg+xml", size: 100 },
      { name: "logo.png", type: "image/svg+xml", size: 100 },
      { name: "logo.gif", type: "image/gif", size: 100 },
      { name: "logo.svg", type: "image/png", size: 100 },
      { name: "logo.html", type: "text/html", size: 100 },
    ]) {
      expect({ f, r: validateLogoFile(f) }).toEqual({ f, r: { key: "media.unsupported_type", extra: { allowed: ["image/png", "image/jpeg", "image/webp"] } } });
    }
    expect(validateLogoFile({ name: "x.png", type: "image/png", size: 0 })).toEqual({ key: "media.no_file", extra: {} });
    expect(validateLogoFile(null)).toEqual({ key: "media.no_file", extra: {} });
  });

  it("copy for the client checks, the server's keys and the colour key", () => {
    expect(brandErrorText(logoCheckError({ key: "media.too_large", extra: { limit: LOGO_MAX_BYTES } }), en)).toMatch(/2/);
    expect(brandErrorText(logoCheckError({ key: "media.unsupported_type", extra: { allowed: [...LOGO_TYPES] } }), ar)).toMatch(ARABIC);
    const colour = new ApiError("workspaces.invalid_brand_color", 400, undefined, { statusCode: 400, message: "workspaces.invalid_brand_color" });
    expect(brandErrorText(colour, en)).toMatch(/#c9a55a/);
    expect(brandErrorText(colour, ar)).toMatch(ARABIC);
    const inUse = new ApiError("media.in_use", 409, undefined, {
      statusCode: 409,
      message: "media.in_use",
      templates: [],
      campaigns: [],
      tickets: [],
      knowledge: [],
      workspaces: [{ id: "ws1" }],
    });
    expect(brandErrorText(inUse, en)).toMatch(/logo/i);
    expect(brandErrorText(inUse, ar)).toMatch(ARABIC);
  });
});
