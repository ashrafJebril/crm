/**
 * SP-29 brand colour (pure; mirrored in `src/lib/brandColor.ts`, a test pins
 * equality on a fixture list).
 *
 *  - normalizeBrandColor: `#rgb` / `#rrggbb` (any case) → lower-case `#rrggbb`;
 *    null/undefined/"" clear (null); anything else is 400
 *    `workspaces.invalid_brand_color`. The result is always 7 safe characters,
 *    so it can never inject CSS or HTML wherever it is written.
 *  - brandInk: the text colour on the brand colour, `#ffffff` or `#111111`,
 *    whichever has the higher WCAG contrast ratio.
 */
import { BadRequestException } from "@nestjs/common";
import { BRAND_COLOR_RE } from "./brand-constants";

export const INK_LIGHT = "#ffffff";
export const INK_DARK = "#111111";

export function invalidBrandColor(): BadRequestException {
  return new BadRequestException({ statusCode: 400, message: "workspaces.invalid_brand_color" });
}

/** The stored form, or null to clear. Throws 400 on anything else. */
export function normalizeBrandColor(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") throw invalidBrandColor();
  const s = v.trim();
  if (!BRAND_COLOR_RE.test(s)) throw invalidBrandColor();
  const hex = s.slice(1).toLowerCase();
  return `#${hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex}`;
}

/** A stored value that is safe to emit (re-checked on read: never trust the column blindly). */
export function safeBrandColor(v: unknown): string | null {
  try {
    return normalizeBrandColor(v);
  } catch {
    return null;
  }
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const h = normalizeBrandColor(hex) as string;
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** The higher-contrast text colour on `bg`. */
export function brandInk(bg: string): typeof INK_LIGHT | typeof INK_DARK {
  return contrastRatio(bg, INK_LIGHT) >= contrastRatio(bg, INK_DARK) ? INK_LIGHT : INK_DARK;
}
