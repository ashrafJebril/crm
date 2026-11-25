/**
 * SP-29 brand colour (pure mirror of backend/src/workspaces/brand-color.ts;
 * brandColor.test.ts pins it to the backend fixtures). The colour only ever
 * reaches CSS through `safeBrandColor` (re-validated here, whatever the
 * server sent).
 */
export const BRAND_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
export const INK_LIGHT = "#ffffff";
export const INK_DARK = "#111111";

/** `#rgb` / `#rrggbb` (any case) → lower-case `#rrggbb`; "" / null → null; anything else → undefined (invalid). */
export function normalizeBrandColor(v: unknown): string | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!BRAND_COLOR_RE.test(s)) return undefined;
  const hex = s.slice(1).toLowerCase();
  return `#${hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex}`;
}

/** A colour safe to put in a style, or null. */
export function safeBrandColor(v: unknown): string | null {
  return normalizeBrandColor(v) ?? null;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const h = safeBrandColor(hex) ?? "#000000";
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
export function brandInk(bg: string): string {
  return contrastRatio(bg, INK_LIGHT) >= contrastRatio(bg, INK_DARK) ? INK_LIGHT : INK_DARK;
}

/** Initials for a workspace mark (Latin or Arabic letters; at most two). */
export function workspaceInitials(name: string | null | undefined): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  const chars = parts.length > 1 ? [parts[0][0], parts[1][0]] : Array.from(parts[0] ?? "").slice(0, 2);
  return chars.join("").toUpperCase() || "•";
}
