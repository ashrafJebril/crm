import { useMemo, type CSSProperties } from "react";
import type { Tx } from "@/lib/tx";
import type { Lang, Ticket, TeamMember, TicketStage } from "@/lib/types";
import { Avatar } from "@/components/Avatar";
import { usePermissions } from "@/auth/usePermissions";
import { openRecord } from "@/lib/openRecord";
import { daysInStage } from "./stale";
import { stageColor } from "./stageColors";
import { useTableTickets } from "./hooks/useBoardData";
import type { Sort, SortKey } from "./boardQuery";
import { ChannelChip, PriorityChip, SlaBadgeChip } from "./TicketBadges";
import { categoryLabel } from "./ticketFields";

interface Props {
  tx: Tx;
  lang: Lang;
  tz: string;
  pipelineId: string;
  stages: TicketStage[];
  team: TeamMember[];
  /** Filter + sort query string from boardQuery.toQuery. */
  qs: string;
  sort: Sort;
  onSort: (key: SortKey) => void;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], on: boolean) => void;
  /** Final review I1: the SLA column on support pipelines only. */
  showSla?: boolean;
}

const th: CSSProperties = {
  textAlign: "start",
  padding: "8px 10px",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--ink-3)",
  letterSpacing: 0.4,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  position: "sticky",
  top: 0,
  background: "var(--bg-1)",
  borderBottom: "1px solid var(--line)",
  zIndex: 1,
};
const td: CSSProperties = { padding: "8px 10px", fontSize: 12.5, color: "var(--ink)", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" };

export function PipelineTable({ tx, lang, tz, pipelineId, stages, team, qs, sort, onSort, selected, onToggle, onToggleAll, showSla = true }: Props) {
  const q = useTableTickets(pipelineId, qs);
  const canUpdate = usePermissions().can("tickets.update");
  const num = (n: number) => n.toLocaleString(lang === "ar" ? "ar" : "en");
  const rows: Ticket[] = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total ?? 0;
  const stageById = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);
  const owner = useMemo(() => new Map(team.map((m) => [m.id, m.name])), [team]);
  const fmt = useMemo(
    () => new Intl.DateTimeFormat(lang === "ar" ? "ar" : "en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric" }),
    [lang, tz],
  );
  const date = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : fmt.format(d);
  };
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const sortable = (key: SortKey, label: string) => {
    const active = sort.key === key;
    // Time in stage is the inverse of enteredStageAt: oldest entry (asc) = longest in stage, shown as ▼.
    const shownDir = key === "enteredStageAt" ? (sort.dir === "asc" ? "desc" : "asc") : sort.dir;
    return (
      <th style={th} aria-sort={active ? (shownDir === "asc" ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          onClick={() => onSort(key)}
          style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", font: "inherit", color: active ? "var(--ink)" : "inherit", textTransform: "inherit", letterSpacing: "inherit" }}
        >
          {label} {active ? (shownDir === "asc" ? "▲" : "▼") : ""}
        </button>
      </th>
    );
  };

  if (q.isPending) return <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 12 }}>{tx("Loading…", "جارٍ التحميل…")}</div>;
  if (q.isError)
    return (
      <div role="alert" style={{ padding: 24, color: "var(--bad, #ef4444)", fontSize: 13 }}>
        {tx("Could not load tickets", "تعذر تحميل التذاكر")}{" "}
        <button type="button" onClick={() => void q.refetch()} style={{ marginInlineStart: 8, cursor: "pointer" }}>
          {tx("Retry", "إعادة المحاولة")}
        </button>
      </div>
    );

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "0 18px 16px" }}>
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 1280 }}>
        <thead>
          <tr>
            <th style={{ ...th, width: 32 }}>
              {canUpdate ? (
                <input
                  type="checkbox"
                  aria-label={tx("Select all rows", "تحديد كل الصفوف")}
                  checked={allOn}
                  onChange={(e) => onToggleAll(rows.map((r) => r.id), e.target.checked)}
                />
              ) : null}
            </th>
            <th style={th}>#</th>
            <th style={th}>{tx("Title", "العنوان")}</th>
            <th style={th}>{tx("Contact", "جهة الاتصال")}</th>
            <th style={th}>{tx("Stage", "المرحلة")}</th>
            <th style={th}>{tx("Owner", "المسؤول")}</th>
            {sortable("priority", tx("Priority", "الأولوية"))}
            <th style={th}>{tx("Category", "التصنيف")}</th>
            <th style={th}>{tx("Channel", "القناة")}</th>
            {showSla ? sortable("slaDueAt", tx("SLA", "المهلة")) : null}
            {sortable("value", tx("Value", "القيمة"))}
            {sortable("createdAt", tx("Created", "أُنشئت"))}
            {sortable("updatedAt", tx("Updated", "حُدّثت"))}
            {sortable("enteredStageAt", tx("Time in stage", "المدة في المرحلة"))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={showSla ? 14 : 13} style={{ ...td, textAlign: "center", color: "var(--ink-3)", padding: 32 }}>
                {tx("No tickets match these filters", "لا توجد تذاكر تطابق هذه المرشحات")}
              </td>
            </tr>
          ) : null}
          {rows.map((t) => {
            const stage = t.stage ?? stageById.get(t.stageId);
            const accent = stage ? stageColor[stage.color] ?? "var(--ink-3)" : "var(--ink-3)";
            const days = daysInStage(t.enteredStageAt);
            return (
              <tr
                key={t.id}
                tabIndex={0}
                onClick={() => openRecord("ticket", t.id)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    openRecord("ticket", t.id);
                  }
                }}
                style={{ cursor: "pointer", background: selected.has(t.id) ? "color-mix(in srgb, var(--accent) 8%, transparent)" : undefined }}
              >
                <td style={td} onClick={(e) => e.stopPropagation()}>
                  {canUpdate ? (
                    <input
                      type="checkbox"
                      aria-label={tx(`Select ticket ${t.number}`, `تحديد التذكرة ${t.number}`)}
                      checked={selected.has(t.id)}
                      onChange={() => onToggle(t.id)}
                    />
                  ) : null}
                </td>
                <td style={td} className="mono"><bdi>#{String(t.number).padStart(3, "0")}</bdi></td>
                <td style={{ ...td, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600 }} dir="auto">{t.title}</td>
                <td style={td}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Avatar name={t.contact?.name ?? "?"} size="sm" />
                    <span dir="auto">{t.contact?.name ?? "—"}</span>
                  </span>
                </td>
                <td style={td}>
                  {stage ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 999, background: accent }} />
                      <span dir="auto">{lang === "ar" ? stage.labelAr : stage.label}</span>
                    </span>
                  ) : "—"}
                </td>
                <td style={td} dir="auto">{t.ownerId ? owner.get(t.ownerId) ?? "—" : tx("Unassigned", "غير مُسند")}</td>
                <td style={td}><PriorityChip tx={tx} priority={t.priority} always /></td>
                <td style={td}>{categoryLabel(tx, t.category) ?? "—"}</td>
                <td style={td}>{t.channel ? <ChannelChip tx={tx} channel={t.channel} /> : "—"}</td>
                {showSla ? (
                  <td style={td}>
                    <SlaBadgeChip tx={tx} tz={tz} ticket={t} stageIsTerminal={stage?.isTerminal} showNone />
                  </td>
                ) : null}
                <td style={td} className="mono">{t.value != null ? `${num(t.value)} ${t.currency ?? "SAR"}` : "—"}</td>
                <td style={td}>{date(t.createdAt)}</td>
                <td style={td}>{date(t.updatedAt)}</td>
                <td style={td}>{t.closedAt ? "—" : tx(`${num(days)}d`, `${num(days)} يوم`)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 4px", fontSize: 12.5, color: "var(--ink-3)" }} aria-live="polite">
        <span>
          {tx(`${num(rows.length)} of ${num(total)}`, `${num(rows.length)} من ${num(total)}`)}
        </span>
        {q.hasNextPage ? (
          <button type="button" className="btn sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? tx("Loading…", "جارٍ التحميل…") : tx("Load more", "تحميل المزيد")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
