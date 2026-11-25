import { useEffect, useMemo, useRef, useState } from "react";
import type { Tx } from "@/lib/tx";
import type { Lang } from "@/lib/types";
import { dailySeries, formatAdMoney, type Bar, type DailyIn } from "./adsModel";

/**
 * SP-15 daily chart: conversations started and spend as two small multiples
 * sharing the day axis (never one chart with two y-scales). Pure SVG, like
 * `components/charts.tsx`. The day axis runs from the inline start, so it
 * mirrors in RTL; values stay in Latin digits. Each bar has a hover/focus
 * tooltip, and the numbers are also available as a table.
 */

const H = 96;
const GAP = 2;
const PAD_TOP = 14;

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || 600);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const shortDay = (day: string, lang: Lang) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(lang === "ar" ? "ar-u-nu-latn" : "en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const barDays = (b: Bar, lang: Lang) => (b.from === b.to ? shortDay(b.from, lang) : `${shortDay(b.from, lang)} – ${shortDay(b.to, lang)}`);

/** Rounded top only (4px), anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function Strip({
  title,
  bars,
  value,
  format,
  color,
  width,
  rtl,
  lang,
  hover,
  setHover,
}: {
  title: string;
  bars: Bar[];
  value: (b: Bar) => number;
  format: (n: number) => string;
  color: string;
  width: number;
  rtl: boolean;
  lang: Lang;
  hover: number | null;
  setHover: (i: number | null) => void;
}) {
  const max = Math.max(...bars.map(value), 0);
  const n = bars.length;
  const slot = width / Math.max(1, n);
  const bw = Math.max(1, slot - GAP);
  const plotH = H - PAD_TOP;
  const xOf = (i: number) => (rtl ? width - (i + 1) * slot : i * slot) + GAP / 2;
  const peak = max > 0 ? bars.findIndex((b) => value(b) === max) : -1;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--ink-3)" }}>
        <span>{title}</span>
        <span>
          {format(bars.reduce((s, b) => s + value(b), 0))}
        </span>
      </div>
      <svg width={width} height={H} role="img" aria-label={title} style={{ display: "block", overflow: "visible" }}>
        <line x1={0} x2={width} y1={H - 0.5} y2={H - 0.5} stroke="var(--line)" />
        <line x1={0} x2={width} y1={PAD_TOP} y2={PAD_TOP} stroke="var(--line-soft)" strokeDasharray="2 4" />
        {bars.map((b, i) => {
          const v = value(b);
          const h = max > 0 ? (v / max) * plotH : 0;
          const x = xOf(i);
          return (
            <g key={b.from}>
              <path d={barPath(x, H - h, bw, h)} fill={color} opacity={hover === null || hover === i ? 1 : 0.45} />
              <rect
                x={x - GAP / 2}
                y={0}
                width={slot}
                height={H}
                fill="transparent"
                tabIndex={0}
                aria-label={`${barDays(b, lang)}: ${format(v)}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
        {peak >= 0 && hover === null && (
          <text
            x={xOf(peak) + bw / 2}
            y={PAD_TOP - 3}
            textAnchor="middle"
            fontSize={10}
            fill="var(--ink-2)"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {format(max)}
          </text>
        )}
      </svg>
    </div>
  );
}

export function AdsDailyChart({
  daily,
  currency,
  spendUnknownText,
  tx,
  lang,
}: {
  daily: DailyIn[];
  /** The spend currency; null with all-null spend shows the Unknown note instead of a spend strip. */
  currency: string | null;
  spendUnknownText: string;
  tx: Tx;
  lang: Lang;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const bars = useMemo(() => dailySeries(daily, 31), [daily]);
  const rtl = lang === "ar";
  const spendKnown = !!currency && bars.some((b) => b.spend !== null);
  const money = (n: number) => (currency ? formatAdMoney(n, currency, lang) : String(n));
  const int = (n: number) => new Intl.NumberFormat("en-US").format(n);

  if (bars.length === 0) return null;
  const hovered = hover !== null ? bars[hover] : null;

  return (
    <div ref={ref} style={{ display: "grid", gap: 12, position: "relative", minWidth: 0 }}>
      <div aria-live="polite" style={{ minHeight: 18, fontSize: 12, color: "var(--ink-2)" }}>
        {hovered ? (
          <>
            <bdi>{barDays(hovered, lang)}</bdi>
            {" · "}
            {tx("Started", "بدأت")} <bdi style={{ fontVariantNumeric: "tabular-nums" }}>{int(hovered.started)}</bdi>
            {" · "}
            {tx("Spend", "الإنفاق")}{" "}
            {spendKnown && hovered.spend !== null ? (
              <bdi style={{ fontVariantNumeric: "tabular-nums" }}>{money(hovered.spend)}</bdi>
            ) : (
              <span className="muted">{tx("Unknown", "غير معروف")}</span>
            )}
          </>
        ) : (
          <span className="muted">{tx("Hover a day for its numbers", "مرّر فوق يوم لعرض أرقامه")}</span>
        )}
      </div>
      <Strip
        title={tx("Conversations started", "المحادثات التي بدأت")}
        bars={bars}
        value={(b) => b.started}
        format={int}
        color="var(--accent)"
        width={width}
        rtl={rtl}
        lang={lang}
        hover={hover}
        setHover={setHover}
      />
      {spendKnown ? (
        <Strip
          title={tx(`Spend (${currency})`, `الإنفاق (${currency})`)}
          bars={bars}
          value={(b) => b.spend ?? 0}
          format={money}
          color="var(--info)"
          width={width}
          rtl={rtl}
          lang={lang}
          hover={hover}
          setHover={setHover}
        />
      ) : (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {tx("Spend", "الإنفاق")}: <span title={spendUnknownText}>{tx("Unknown", "غير معروف")}</span> · {spendUnknownText}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--ink-3)" }}>
        <bdi>{shortDay(bars[0].from, lang)}</bdi>
        <bdi>{shortDay(bars[bars.length - 1].to, lang)}</bdi>
      </div>
      <details style={{ fontSize: 12 }}>
        <summary style={{ cursor: "pointer", color: "var(--ink-3)" }}>{tx("Show as table", "عرض كجدول")}</summary>
        <div style={{ maxHeight: 240, overflow: "auto", marginBlockStart: 6 }}>
          <table className="tbl" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>{tx("Days", "الأيام")}</th>
                <th>{tx("Conversations started", "المحادثات التي بدأت")}</th>
                <th>{tx("Spend", "الإنفاق")}</th>
              </tr>
            </thead>
            <tbody>
              {bars.map((b) => (
                <tr key={b.from}>
                  <td><bdi>{barDays(b, lang)}</bdi></td>
                  <td><bdi>{int(b.started)}</bdi></td>
                  <td>
                    {spendKnown && b.spend !== null ? <bdi>{money(b.spend)}</bdi> : <span className="muted">{tx("Unknown", "غير معروف")}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
