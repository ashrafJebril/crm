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
  return (
    <header
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--line)",
        display: "flex",
        gap: 12,
        alignItems: "center",
        flexWrap: "wrap",
        background: "var(--bg-1)",
      }}
    >
      <select
        value={selectedPipelineId}
        onChange={(e) => onPipelineChange(e.target.value)}
        style={ctrl}
      >
        {pipelines.map((p) => (
          <option key={p.id} value={p.id}>
            {lang === "ar" ? p.nameAr : p.name}
          </option>
        ))}
      </select>

      <Kpi
        label={lang === "ar" ? "القيمة المفتوحة" : "Open value"}
        value={
          summary
            ? `${summary.openValue.toLocaleString()} ${summary.currency}`
            : "—"
        }
      />
      <Kpi
        label={lang === "ar" ? "معدل الفوز" : "Win rate"}
        value={summary ? `${summary.winRate}%` : "—"}
      />
      <Kpi
        label={lang === "ar" ? "المتوسط (ساعة)" : "Avg close (h)"}
        value={summary ? String(summary.avgCloseHours) : "—"}
      />
      <Kpi
        label={lang === "ar" ? "العدد" : "Total"}
        value={summary ? String(summary.totalTickets) : "—"}
      />

      <input
        type="search"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={lang === "ar" ? "بحث (/ للتركيز)" : "Search (/ to focus)"}
        data-pipeline-search
        style={{ ...ctrl, minWidth: 200, flex: "1 1 auto" }}
      />

      <select
        value={ownerFilter}
        onChange={(e) => onOwnerChange(e.target.value)}
        style={ctrl}
      >
        <option value="">{lang === "ar" ? "كل المالكين" : "All owners"}</option>
        {owners.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>

      <button type="button" onClick={onNewTicket} style={btn}>
        + {lang === "ar" ? "جديد (N)" : "New (N)"}
      </button>
    </header>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "4px 10px",
        background: "var(--bg-2)",
        borderRadius: "var(--r)",
        border: "1px solid var(--line)",
        minWidth: 90,
      }}
    >
      <span style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}>
        {label}
      </span>
      <strong style={{ fontSize: 13, color: "var(--ink)" }}>{value}</strong>
    </div>
  );
}

const ctrl: React.CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: "6px 10px",
  color: "var(--ink)",
  fontSize: 13,
};

const btn: React.CSSProperties = {
  background: "var(--accent)",
  color: "white",
  border: 0,
  borderRadius: "var(--r)",
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
};
