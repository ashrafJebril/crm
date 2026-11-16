import type { ReactNode } from "react";
import type { Tx } from "@/lib/tx";
import { NO_DATA, UNAVAILABLE_COPY, sectionView } from "./insightsModel";
import type { Section } from "./insightsTypes";

/** A stat tile (the Analytics `.stat` pattern) with an optional explanation tooltip. */
export function InsightStat({ label, value, sub, tip }: { label: string; value: string; sub?: string; tip?: string }) {
  return (
    <div className="stat" style={{ padding: 14 }} title={tip}>
      <div className="label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span>{label}</span>
        {tip && (
          <span aria-label={tip} role="img" className="mono" style={{ fontSize: 10, color: "var(--ink-3)", border: "1px solid var(--line)", borderRadius: 99, inlineSize: 14, blockSize: 14, display: "inline-grid", placeItems: "center" }}>
            i
          </span>
        )}
      </div>
      <div className="value" style={{ fontSize: 24 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{sub}</div>}
    </div>
  );
}

/**
 * A card for one independently computed section: `ok` renders `children`,
 * `unavailable` shows a notice, `forbidden` renders nothing.
 */
export function SectionCard<T>({
  title,
  sub,
  section,
  tx,
  empty,
  children,
}: {
  title: string;
  sub?: string;
  section: Section<T> | undefined;
  tx: Tx;
  /** True when the ok data holds nothing to draw ("No data yet"). */
  empty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  const v = sectionView(section);
  if (v.kind === "hidden") return null;
  return (
    <div className="card">
      <div className="card-h">
        <h3>{title}</h3>
        {sub && <span className="sub">{sub}</span>}
      </div>
      <div style={{ padding: 18 }}>
        {v.kind === "unavailable" ? (
          <div role="status" style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{tx(UNAVAILABLE_COPY[0], UNAVAILABLE_COPY[1])}</div>
        ) : empty?.(v.data) ? (
          <div className="muted" style={{ fontSize: 12.5 }}>{tx(NO_DATA[0], NO_DATA[1])}</div>
        ) : (
          children(v.data)
        )}
      </div>
    </div>
  );
}

/** Headline tiles: the same three states, without a card. */
export function SectionTiles<T>({ section, tx, children }: { section: Section<T> | undefined; tx: Tx; children: (data: T) => ReactNode }) {
  const v = sectionView(section);
  if (v.kind === "hidden") return null;
  if (v.kind === "unavailable")
    return (
      <div role="status" className="card" style={{ padding: 14, fontSize: 12.5, color: "var(--ink-3)" }}>
        {tx(UNAVAILABLE_COPY[0], UNAVAILABLE_COPY[1])}
      </div>
    );
  return <>{children(v.data)}</>;
}

/** A horizontal share bar (logical direction, so it grows from the start edge in RTL). */
export function ShareBar({ fraction, color = "var(--accent)", label }: { fraction: number; color?: string; label?: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div aria-hidden={label ? undefined : true} aria-label={label} style={{ blockSize: 8, background: "var(--bg-2)", borderRadius: 4, overflow: "hidden" }}>
      <div style={{ inlineSize: `${pct}%`, blockSize: "100%", background: color, borderRadius: 4 }} />
    </div>
  );
}

export const gridCols = (n: number) => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${n}px, 1fr))`, gap: 12 }) as const;
