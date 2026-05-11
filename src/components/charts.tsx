// Pure SVG charts. No chart lib. Memoized so they don't re-render with the
// surrounding screen unless their inputs change.

import { memo } from "react";

interface SparkProps {
  values: number[];
  w?: number;
  h?: number;
  color?: string;
}

export const Spark = memo(function Spark({
  values,
  w = 120,
  h = 32,
  color = "var(--accent)",
}: SparkProps) {
  if (!values.length) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  const path = values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${i * step} ${h - ((v - min) / range) * h}`)
    .join(" ");
  const area = `${path} L ${w} ${h} L 0 ${h} Z`;
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <path d={area} fill={color} opacity="0.15" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
});

interface BarsProps {
  values: number[];
  w?: number;
  h?: number;
  color?: string;
  labels?: string[];
}

export const Bars = memo(function Bars({
  values,
  w = 360,
  h = 90,
  color = "var(--accent)",
  labels,
}: BarsProps) {
  const max = Math.max(...values, 1);
  const bw = w / values.length - 4;
  return (
    <div style={{ position: "relative" }}>
      <svg width={w} height={h}>
        {values.map((v, i) => {
          const bh = (v / max) * (h - 4);
          return (
            <rect
              key={i}
              x={i * (bw + 4)}
              y={h - bh}
              width={bw}
              height={bh}
              rx="2"
              fill={color}
              opacity={0.6 + 0.4 * (v / max)}
            />
          );
        })}
      </svg>
      {labels && (
        <div
          style={{
            display: "flex",
            gap: 4,
            marginTop: 4,
            fontSize: 10,
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {labels.map((l, i) => (
            <div key={i} style={{ width: bw + 4, textAlign: "center" }}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

interface AreaChartProps {
  a: number[];
  b: number[];
  w?: number;
  h?: number;
}

export const AreaChart = memo(function AreaChart({
  a,
  b,
  w = 600,
  h = 180,
}: AreaChartProps) {
  const max = Math.max(...a, ...b) * 1.1 || 1;
  const sx = w / (a.length - 1);
  const path = (vs: number[]) =>
    vs.map((v, i) => `${i === 0 ? "M" : "L"} ${i * sx} ${h - (v / max) * (h - 24) - 12}`).join(" ");
  const area = (vs: number[]) => `${path(vs)} L ${w} ${h} L 0 ${h} Z`;
  return (
    <svg width={w} height={h} style={{ display: "block", maxWidth: "100%" }}>
      {[0, 0.25, 0.5, 0.75, 1].map((p, i) => (
        <line
          key={i}
          x1="0"
          x2={w}
          y1={p * (h - 24) + 12}
          y2={p * (h - 24) + 12}
          stroke="var(--line-soft)"
          strokeDasharray="2 4"
        />
      ))}
      <path d={area(a)} fill="var(--accent)" opacity="0.12" />
      <path d={path(a)} fill="none" stroke="var(--accent)" strokeWidth="2" />
      <path d={path(b)} fill="none" stroke="var(--ink-3)" strokeWidth="1.5" strokeDasharray="3 3" />
    </svg>
  );
});

interface DonutItem {
  value: number;
  color: string;
  label?: string;
}

interface DonutProps {
  items: DonutItem[];
  size?: number;
  thickness?: number;
}

export const Donut = memo(function Donut({ items, size = 140, thickness = 18 }: DonutProps) {
  const total = items.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--line-soft)"
        strokeWidth={thickness}
      />
      {items.map((it, i) => {
        const len = (it.value / total) * c;
        const dasharray = `${len} ${c - len}`;
        const el = (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={it.color}
            strokeWidth={thickness}
            strokeDasharray={dasharray}
            strokeDashoffset={-off}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        );
        off += len;
        return el;
      })}
    </svg>
  );
});

interface HeatmapProps {
  data: number[][];
  w?: number;
  cell?: number;
}

export const Heatmap = memo(function Heatmap({ data, w = 560, cell = 18 }: HeatmapProps) {
  const max = Math.max(...data.flat(), 1);
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  return (
    <svg width={w} height={cell * 7 + 30}>
      {data.map((row, d) =>
        row.map((v, h) => (
          <rect
            key={`${d}-${h}`}
            x={h * (cell + 2) + 22}
            y={d * (cell + 2)}
            width={cell}
            height={cell}
            rx="3"
            fill="var(--accent)"
            opacity={0.05 + (v / max) * 0.95}
          />
        ))
      )}
      {days.map((dl, d) => (
        <text
          key={d}
          x={0}
          y={d * (cell + 2) + 13}
          fontSize="10"
          fontFamily="var(--font-mono)"
          fill="var(--ink-3)"
        >
          {dl}
        </text>
      ))}
      {[0, 6, 12, 18, 23].map((h) => (
        <text
          key={h}
          x={h * (cell + 2) + 22}
          y={cell * 7 + 14}
          fontSize="10"
          fontFamily="var(--font-mono)"
          fill="var(--ink-3)"
        >
          {`${String(h).padStart(2, "0")}:00`}
        </text>
      ))}
    </svg>
  );
});
