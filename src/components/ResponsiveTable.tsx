import type { CSSProperties, ReactNode } from "react";

/**
 * SP-30: a table that scrolls inside its own container (never the page).
 * `max-inline-size: 100%` with `overflow-x: auto`; `stickyFirst` keeps the
 * first column in place while the rest scrolls (logical: the inline start).
 */
export function ResponsiveTable({
  children,
  className,
  style,
  stickyFirst = false,
  label,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  stickyFirst?: boolean;
  /** Accessible name for the scroll region (it is focusable so keyboards can scroll it). */
  label?: string;
}) {
  return (
    <div
      className={["rtable", stickyFirst ? "rtable--sticky-first" : "", className ?? ""].filter(Boolean).join(" ")}
      style={style}
      role={label ? "region" : undefined}
      aria-label={label}
      tabIndex={label ? 0 : undefined}
    >
      {children}
    </div>
  );
}
