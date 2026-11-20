import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BP, CSS_MEDIA_WIDTHS, layoutFor, shellMode, toggledCollapsedPref } from "./breakpoints";

// Read with fs (vitest empties CSS module imports). Every stylesheet under
// src/styles and src/screens, and every .tsx that carries an inline <style> block.
const SRC = resolve(__dirname, "..");
function walk(dir: string, ext: string, deep: boolean): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (deep) out.push(...walk(p, ext, deep));
    } else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}
const load = (files: string[]) => Object.fromEntries(files.map((f) => ["/src/" + relative(SRC, f).split("\\").join("/"), readFileSync(f, "utf8")]));
const CSS: Record<string, string> = load([...walk(resolve(SRC, "styles"), ".css", false), ...walk(resolve(SRC, "screens"), ".css", true)]);
const TSX: Record<string, string> = load(walk(SRC, ".tsx", true));

const MEDIA_WIDTH = /\((?:min|max)-width:\s*([\d.]+)px\)/g;

function widthsIn(src: string): number[] {
  const out: number[] = [];
  for (const block of src.match(/@media[^{]*\{/g) ?? []) {
    for (const m of block.matchAll(MEDIA_WIDTH)) out.push(Number(m[1]));
  }
  return out;
}

describe("each screen is verified at 390px width through the verify skill with no horizontal scroll", () => {
  it("shell mode by width and preference", () => {
    expect(shellMode(390, null)).toBe("drawer");
    expect(shellMode(390, false)).toBe("drawer");
    expect(shellMode(800, null)).toBe("rail");
    expect(shellMode(800, true)).toBe("rail");
    expect(shellMode(800, false)).toBe("full");
    expect(shellMode(1440, null)).toBe("full");
    expect(shellMode(1440, false)).toBe("full");
    expect(shellMode(1440, true)).toBe("rail");
    // Boundaries.
    expect(shellMode(767, null)).toBe("drawer");
    expect(shellMode(768, null)).toBe("rail");
    expect(shellMode(1279, null)).toBe("rail");
    expect(shellMode(1280, null)).toBe("full");
    // The toggle stores the opposite of what is shown.
    expect(shellMode(800, toggledCollapsedPref(shellMode(800, null)))).toBe("full");
    expect(shellMode(1440, toggledCollapsedPref(shellMode(1440, null)))).toBe("rail");
    expect(layoutFor(390)).toBe("phone");
    expect(layoutFor(767)).toBe("phone");
    expect(layoutFor(768)).toBe("tablet");
    expect(layoutFor(1024)).toBe("desktop");
    expect(layoutFor(1280)).toBe("wide");
  });

  it("css media queries use only the breakpoint scale", () => {
    expect(BP).toEqual({ sm: 640, md: 768, lg: 1024, xl: 1280 });
    expect(Object.keys(CSS).length).toBeGreaterThan(2);
    const bad: string[] = [];
    for (const [file, src] of [...Object.entries(CSS), ...Object.entries(TSX)]) {
      for (const w of widthsIn(src)) if (!CSS_MEDIA_WIDTHS.includes(w)) bad.push(`${file}: ${w}px`);
    }
    expect(bad).toEqual([]);
    // The lint itself catches an off-scale width.
    expect(widthsIn("@media (max-width: 1100px) { .x { } }").every((w) => CSS_MEDIA_WIDTHS.includes(w))).toBe(false);
    expect(widthsIn("@media (max-width: 767.98px) { .x { } }")).toEqual([767.98]);
  });

  it("dialog rule exists for phones", () => {
    const app = CSS["/src/styles/app.css"];
    expect(app).toBeTruthy();
    const block = /@media \(max-width: 639\.98px\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";
    expect(block).toMatch(/\.dialog\s*\{[^}]*inline-size:\s*100vw/);
    expect(block).toMatch(/\.dialog\s*\{[^}]*block-size:\s*100dvh/);
    expect(block).toMatch(/\.dialog\s*\{[^}]*border-radius:\s*0/);
  });
});
