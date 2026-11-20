import { describe, expect, it } from "vitest";
// The backend spec is the fixture (read as text; never compiled here).
import backendSpec from "../../backend/src/workspaces/brand-color.spec.ts?raw";
import { brandInk, contrastRatio, INK_DARK, INK_LIGHT, normalizeBrandColor, safeBrandColor, workspaceInitials } from "./brandColor";

/** BRAND_FIXTURES from backend/src/workspaces/brand-color.spec.ts: [input, normalised, ink]. */
function fixtures(): [string, string, string][] {
  const m = /BRAND_FIXTURES[^=]*=\s*\[([\s\S]*?)\];/.exec(backendSpec);
  if (!m) throw new Error("BRAND_FIXTURES not found");
  const ink = (id: string) => (id === "INK_DARK" ? INK_DARK : id === "INK_LIGHT" ? INK_LIGHT : id.replace(/"/g, ""));
  return [...m[1].matchAll(/\["([^"]+)",\s*"([^"]+)",\s*([A-Z_]+|"[^"]+")\]/g)].map((x) => [x[1], x[2], ink(x[3])]);
}

describe("brand colour mirror matches the backend fixtures", () => {
  it("normalises and picks the same ink for every backend fixture", () => {
    const list = fixtures();
    expect(list.length).toBeGreaterThanOrEqual(5);
    for (const [input, norm, ink] of list) {
      expect({ input, norm: normalizeBrandColor(input), ink: brandInk(input) }).toEqual({ input, norm, ink });
      expect(contrastRatio(norm, ink)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("refuses anything that is not a hex colour (never reaches a style)", () => {
    for (const bad of ["red", "#12345", "#gggggg", "url(x)", "#fff;}a{", 7, {}]) {
      expect(normalizeBrandColor(bad)).toBeUndefined();
      expect(safeBrandColor(bad)).toBeNull();
    }
    expect(normalizeBrandColor("")).toBeNull();
    expect(normalizeBrandColor(null)).toBeNull();
  });

  it("workspace initials", () => {
    expect(workspaceInitials("Salon Noor")).toBe("SN");
    expect(workspaceInitials("kewy")).toBe("KE");
    expect(workspaceInitials("صالون نور")).toBe("صن");
    expect(workspaceInitials("")).toBe("•");
  });
});
