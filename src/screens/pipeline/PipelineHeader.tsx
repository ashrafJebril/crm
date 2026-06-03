import type { CSSProperties } from "react";
import type { Lang, Pipeline, TicketsDashboardSummary } from "@/lib/types";

interface Props {
  lang: Lang;
  pipelines: Pipeline[];
  selectedPipelineId: string;
  onPipelineChange: (id: string) => void;
  summary: TicketsDashboardSummary | undefined;
  search: string;
  onSearchChange: (q: string) => void;
  ownerFilter: string;
  onOwnerChange: (id: string) => void;
  onNewTicket: () => void;
  owners: Array<{ id: string; name: string }>;
}

export function PipelineHeader({
  lang,
  pipelines,
  selectedPipelineId,
  onPipelineChange,
  summary,
  search,
  onSearchChange,
  ownerFilter,
  onOwnerChange,
  onNewTicket,
  owners,
}: Props) {
  const winRateColor =
    summary == null
      ? "var(--ink-2)"
      : summary.winRate >= 60
        ? "var(--ok, #10b981)"
        : summary.winRate >= 30
          ? "var(--warn, #f59e0b)"
          : summary.totalTickets > 0
            ? "var(--bad, #ef4444)"
            : "var(--ink-2)";

  return (
    <header
      style={{
        padding: "14px 18px 12px",
        borderBottom: "1px solid var(--line)",
        background:
          "linear-gradient(180deg, var(--bg-1) 0%, color-mix(in srgb, var(--bg-1) 92%, var(--bg-2)) 100%)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <select
          value={selectedPipelineId}
          onChange={(e) => onPipelineChange(e.target.value)}
          style={{
            ...ctrl,
            fontWeight: 600,
            paddingRight: 28,
          }}
        >
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {lang === "ar" ? p.nameAr : p.name}
            </option>
          ))}
        </select>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Kpi
            label={lang === "ar" ? "القيمة المفتوحة" : "Open value"}
            value={
              summary
                ? `${formatCompact(summary.openValue)} ${summary.currency}`
                : "—"
            }
            accent="var(--accent)"
          />
          <Kpi
            label={lang === "ar" ? "معدل الفوز" : "Win rate"}
            value={summary ? `${summary.winRate}%` : "—"}
            accent={winRateColor}
          />
          <Kpi
            label={lang === "ar" ? "متوسط الإغلاق" : "Avg close"}
            value={summary ? `${summary.avgCloseHours}h` : "—"}
            accent="var(--info, #3b82f6)"
          />
          <Kpi
            label={lang === "ar" ? "العدد" : "Total"}
            value={summary ? String(summary.totalTickets) : "—"}
            accent="var(--ink-2)"
          />
        </div>

        <div style={{ flex: 1, minWidth: 200, position: "relative" }}>
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={
              lang === "ar" ? "بحث (/ للتركيز)" : "Search (/ to focus)"
            }
            data-pipeline-search
            style={{
              ...ctrl,
              width: "100%",
              paddingLeft: 32,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--ink-3)",
              fontSize: 13,
              pointerEvents: "none",
            }}
          >
            ⌕
          </div>
        </div>

        <select
          value={ownerFilter}
          onChange={(e) => onOwnerChange(e.target.value)}
          style={ctrl}
        >
          <option value="">
            {lang === "ar" ? "كل المالكين" : "All owners"}
          </option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>

        <button type="button" onClick={onNewTicket} style={btn}>
          <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>{" "}
          {lang === "ar" ? "جديد" : "New"}
          <span
            style={{
              opacity: 0.75,
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              marginLeft: 4,
              padding: "1px 5px",
              background: "rgba(255,255,255,0.18)",
              borderRadius: 4,
            }}
          >
            N
          </span>
        </button>
      </div>
    </header>
  );
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "6px 12px 7px 14px",
        background: "var(--bg-2)",
        borderRadius: 8,
        border: "1px solid var(--line)",
        minWidth: 96,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: accent,
          opacity: 0.75,
        }}
      />
      <span
        style={{
          fontSize: 9.5,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: 0.7,
          fontWeight: 500,
        }}
      >
        {label}
      </span>
      <strong
        style={{
          fontSize: 14,
          color: "var(--ink)",
          fontWeight: 700,
          letterSpacing: -0.2,
        }}
      >
        {value}
      </strong>
    </div>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

const ctrl: CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  padding: "7px 12px",
  color: "var(--ink)",
  fontSize: 12.5,
  outline: "none",
};

const btn: CSSProperties = {
  background:
    "linear-gradient(180deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 85%, black) 100%)",
  color: "white",
  border: 0,
  borderRadius: 8,
  padding: "7px 14px",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  boxShadow:
    "0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.18)",
  letterSpacing: 0.1,
};
