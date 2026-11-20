/**
 * SP-30 breakpoint scale (ruling 2): one source of truth. CSS cannot read
 * custom properties inside `@media`, so the same four values are written as
 * literals in the CSS (documented in tokens.css) and kept honest by
 * `css media queries use only the breakpoint scale` (responsive.test.ts):
 * `min-width: N px` or `max-width: (N - 0.02) px` for N in BP.
 */
export const BP = { sm: 640, md: 768, lg: 1024, xl: 1280 } as const;
export type BreakpointName = keyof typeof BP;

/** The width the phone acceptance pass runs at (verify skill). */
export const PHONE_TEST_WIDTH = 390;
/** The drawer's largest inline size. */
export const DRAWER_MAX_PX = 300;

export type Layout = "phone" | "tablet" | "desktop" | "wide";
export type ShellMode = "drawer" | "rail" | "full";

/** phone < md ≤ tablet < lg ≤ desktop < xl ≤ wide. */
export function layoutFor(width: number): Layout {
  if (width < BP.md) return "phone";
  if (width < BP.lg) return "tablet";
  if (width < BP.xl) return "desktop";
  return "wide";
}

/**
 * The sidebar's shape. Below md: an off-canvas drawer. From md to below xl:
 * an icon rail unless the user expanded it. From xl: full unless the user
 * collapsed it. `collapsedPref` is the remembered per-device choice
 * (`null` = never chosen).
 */
export function shellMode(width: number, collapsedPref: boolean | null | undefined): ShellMode {
  if (width < BP.md) return "drawer";
  if (width < BP.xl) return collapsedPref === false ? "full" : "rail";
  return collapsedPref === true ? "rail" : "full";
}

/** The preference a rail/full toggle stores: the opposite of what is shown. */
export function toggledCollapsedPref(mode: ShellMode): boolean {
  return mode !== "rail";
}

/** Values a CSS `min-width`/`max-width` may use: N, or N − 0.02 for a max bound. */
export const CSS_MEDIA_WIDTHS: readonly number[] = Object.values(BP).flatMap((n) => [n, Math.round((n - 0.02) * 100) / 100]);
