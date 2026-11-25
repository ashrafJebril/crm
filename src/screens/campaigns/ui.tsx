import type { CSSProperties, ReactNode } from "react";
import { safeTz } from "@/screens/followups/followupsLogic";
import type { Lang } from "@/lib/types";

/** Shared campaign UI pieces (list page and SP-12 report). */

interface MiniStatProps {
  label: string;
  value: string;
  sub: string;
}

export function MiniStat({ label, value, sub }: MiniStatProps) {
  return (
    <div className="stat" style={{ padding: 14 }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 22 }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{sub}</div>
    </div>
  );
}

interface InlineBarProps {
  pct: number;
  label: string;
  color?: string;
}

export function InlineBar({ pct, label, color = "var(--accent)" }: InlineBarProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 90 }}>
      <div
        style={{
          flex: 1,
          height: 4,
          background: "var(--bg-2)",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: color, opacity: 0.7 }} />
      </div>
      <span className="mono" style={{ fontSize: 11, color: "var(--ink-2)" }}>
        {label}
      </span>
    </div>
  );
}

export const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export const INPUT_STYLE: CSSProperties = {
  height: 32,
  padding: "0 10px",
  borderRadius: 8,
  background: "var(--bg-1)",
  border: "1px solid var(--line-soft)",
  color: "var(--ink)",
  fontSize: 13,
  outline: 0,
  fontFamily: "inherit",
};

export const fmtNum = (n: number): string => (n ?? 0).toLocaleString("en-US");

/** Date and time in the workspace timezone; null/invalid → "—". */
export function formatWhen(iso: string | null | undefined, lang: Lang, tz: string | null | undefined, short = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(lang === "ar" ? "ar" : "en-GB", {
    timeZone: safeTz(tz),
    ...(short
      ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
      : { dateStyle: "medium", timeStyle: "short" }),
  });
}

/** A card with a title, matching the app's `.card` / `.card-h` pattern. */
export function Card({ title, sub, children, actions }: { title: string; sub?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <div className="card-h">
        <div>
          <h3>{title}</h3>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {actions}
      </div>
      <div style={{ padding: "14px 18px 18px" }}>{children}</div>
    </section>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  /** Plain text of the label, for the aria-label and hidden table. */
  labelText: string;
  count: number;
  /** Bar length, 0..100. */
  barPct: number;
  /** Optional percent text, e.g. "45%". */
  pctText?: string;
  /** Makes the label a button (e.g. open the table filtered). */
  onClick?: () => void;
  clickHint?: string;
}

interface HBarsProps {
  rows: BarRow[];
  /** Reads the numbers, e.g. "Funnel: Targeted 200, Sent 180 (90%)…". */
  ariaLabel: string;
  /** Column headers of the visually hidden table. */
  headers: [label: string, count: string, pct?: string];
  color?: string;
  /** Text direction of the labels (reply text is user-written). */
  labelDir?: "auto";
}

/**
 * Horizontal bars with direct value labels and no legend (single series; the
 * card title names it). Thin 8px marks with a rounded data end, a recessive
 * track, a hover title per bar, `role="img"` with an aria-label that reads the
 * numbers, and a visually hidden table. Colours come from theme tokens.
 * When rows are clickable the bars sit beside real buttons, so `role="img"`
 * goes on each bar instead of the whole chart (buttons inside an img are lost
 * to assistive tech).
 */
export function HBars({ rows, ariaLabel, headers, color = "var(--accent)", labelDir }: HBarsProps) {
  const clickable = rows.some((r) => r.onClick);
  const rowText = (r: BarRow) => `${r.labelText}: ${fmtNum(r.count)}${r.pctText ? ` (${r.pctText})` : ""}`;
  return (
    <div>
      <div
        role={clickable ? "group" : "img"}
        aria-label={ariaLabel}
        style={{ display: "grid", gridTemplateColumns: "minmax(110px, 38%) 1fr auto", alignItems: "center", gap: "8px 12px" }}
      >
        {rows.map((r) => (
          <BarLine key={r.key} row={r} color={color} labelDir={labelDir} clickable={clickable} text={rowText(r)} />
        ))}
      </div>
      <table style={SR_ONLY}>
        <thead>
          <tr>
            {headers.filter(Boolean).map((h) => (
              <th key={h} scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" dir={labelDir}>{r.labelText}</th>
              <td>{fmtNum(r.count)}</td>
              {headers[2] && <td>{r.pctText ?? ""}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarLine({ row: r, color, labelDir, clickable, text }: { row: BarRow; color: string; labelDir?: "auto"; clickable: boolean; text: string }) {
  const labelStyle: CSSProperties = {
    fontSize: 12.5,
    color: "var(--ink-2)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "start",
  };
  return (
    <>
      {r.onClick ? (
        <button
          type="button"
          className="btn ghost sm"
          onClick={r.onClick}
          title={r.clickHint}
          style={{ ...labelStyle, justifyContent: "flex-start", paddingInline: 6, marginInlineStart: -6, color: "var(--ink)" }}
        >
          <span dir={labelDir} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</span>
        </button>
      ) : (
        <span dir={labelDir} style={labelStyle} title={r.labelText}>
          {r.label}
        </span>
      )}
      <div
        role={clickable ? "img" : undefined}
        aria-label={clickable ? text : undefined}
        title={text}
        style={{ height: 8, background: "var(--bg-2)", borderRadius: 4, overflow: "hidden" }}
      >
        <div
          style={{
            width: `${Math.max(0, Math.min(100, r.barPct))}%`,
            minWidth: r.count > 0 ? 2 : 0,
            height: "100%",
            background: color,
            borderStartEndRadius: 4,
            borderEndEndRadius: 4,
          }}
        />
      </div>
      <span className="mono" style={{ fontSize: 12, color: "var(--ink)", whiteSpace: "nowrap", textAlign: "end" }}>
        {fmtNum(r.count)}
        {r.pctText && (
          <span style={{ color: "var(--ink-3)", marginInlineStart: 6 }}>
            <bdi dir="ltr">{r.pctText}</bdi>
          </span>
        )}
      </span>
    </>
  );
}

/** Notice box (info tone, theme tokens). */
export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <div
      role="note"
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        fontSize: 12.5,
        lineHeight: 1.5,
        background: tone === "warn" ? "var(--bg-2)" : "var(--accent-soft)",
        border: `1px solid ${tone === "warn" ? "var(--warn)" : "var(--accent-ring)"}`,
        color: "var(--ink-1, var(--ink))",
      }}
    >
      {children}
    </div>
  );
}
