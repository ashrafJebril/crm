import { useTweaks } from "@/tweaks/context";

/**
 * The Kewy Marketing lockup (mark + wordmark + "MARKETING").
 *
 * Two files rather than one recoloured asset: the supplied SVGs carry
 * theme-specific ink and connector colours, so we pick by theme instead of
 * filtering. `markOnly` is for the collapsed sidebar, where there's no room
 * for the wordmark.
 */
export function BrandLogo({
  height = 30,
  markOnly = false,
}: {
  height?: number;
  markOnly?: boolean;
}) {
  const { t } = useTweaks();
  const src = markOnly
    ? "/brand/kewy-mark.svg"
    : t.theme === "light"
      ? "/brand/kewy-marketing-light.svg"
      : "/brand/kewy-marketing-dark.svg";
  return (
    <img
      src={src}
      alt="Kewy Marketing"
      // The lockup is 240×84 and the mark 72×84 — height drives the box and
      // width follows, so neither ever distorts.
      style={{ height, width: "auto", display: "block", flex: "0 0 auto" }}
    />
  );
}
