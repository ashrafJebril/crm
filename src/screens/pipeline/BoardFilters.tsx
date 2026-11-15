import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Tx } from "@/lib/tx";
import type { TeamMember } from "@/lib/types";
import { useContactSearch } from "./hooks/useBoardData";
import {
  EMPTY_BOARD_FILTERS,
  SLA_FILTERS,
  filtersActive,
  type BoardFilters as Filters,
  type DatePreset,
  type SlaFilter,
  type TicketStatus,
} from "./boardQuery";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, categoryLabel, priorityLabel } from "./ticketFields";

interface Props {
  tx: Tx;
  filters: Filters;
  onChange: (f: Filters) => void;
  team: TeamMember[];
}

const ctrl: CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  padding: "6px 10px",
  color: "var(--ink)",
  fontSize: 12.5,
  outline: "none",
  height: 32,
};

/** Date range presets, customer typeahead, assignee and status pickers; SP-09 priority, category and SLA. */
export function BoardFilters({ tx, filters, onChange, team }: Props) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const presets: Array<[DatePreset, string]> = [
    ["today", tx("Today", "اليوم")],
    ["7d", tx("Last 7 days", "آخر 7 أيام")],
    ["30d", tx("Last 30 days", "آخر 30 يومًا")],
    ["month", tx("This month", "هذا الشهر")],
    ["custom", tx("Custom range", "نطاق مخصص")],
  ];
  const statuses: Array<[TicketStatus, string]> = [
    ["open", tx("Open", "مفتوحة")],
    ["won", tx("Won", "رابحة")],
    ["lost", tx("Lost", "خاسرة")],
  ];
  const slaLabels: Record<SlaFilter, string> = {
    overdue: tx("Overdue", "متأخرة"),
    due_soon: tx("Due soon", "تستحق قريبًا"),
    none: tx("No SLA", "بلا مهلة"),
  };

  return (
    <div
      role="group"
      aria-label={tx("Filters", "المرشحات")}
      style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "8px 18px", borderBottom: "1px solid var(--line)" }}
    >
      <select
        aria-label={tx("Created date", "تاريخ الإنشاء")}
        value={filters.preset ?? ""}
        onChange={(e) => set({ preset: (e.target.value || null) as DatePreset | null })}
        style={ctrl}
      >
        <option value="">{tx("Any date", "أي تاريخ")}</option>
        {presets.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {filters.preset === "custom" ? (
        <>
          <input
            type="date"
            aria-label={tx("From", "من")}
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => set({ from: e.target.value })}
            style={ctrl}
          />
          <span style={{ color: "var(--ink-3)", fontSize: 12 }}>–</span>
          <input
            type="date"
            aria-label={tx("To", "إلى")}
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => set({ to: e.target.value })}
            style={ctrl}
          />
        </>
      ) : null}

      <CustomerPicker tx={tx} filters={filters} set={set} />

      <select
        aria-label={tx("Assignee", "المسؤول")}
        value={filters.ownerId}
        onChange={(e) => set({ ownerId: e.target.value })}
        style={ctrl}
      >
        <option value="">{tx("Any assignee", "أي مسؤول")}</option>
        <option value="none">{tx("Unassigned", "غير مُسند")}</option>
        {team.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>

      <select
        aria-label={tx("Status", "الحالة")}
        value={filters.status}
        onChange={(e) => set({ status: e.target.value as TicketStatus | "" })}
        style={ctrl}
      >
        <option value="">{tx("Any status", "أي حالة")}</option>
        {statuses.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>

      <MultiPick
        tx={tx}
        label={tx("Priority", "الأولوية")}
        anyLabel={tx("Any priority", "أي أولوية")}
        options={TICKET_PRIORITIES.map((p) => [p, priorityLabel(tx, p)] as const)}
        value={filters.priority}
        onChange={(priority) => set({ priority })}
      />

      <MultiPick
        tx={tx}
        label={tx("Category", "التصنيف")}
        anyLabel={tx("Any category", "أي تصنيف")}
        options={TICKET_CATEGORIES.map((c) => [c, categoryLabel(tx, c) ?? c] as const)}
        value={filters.category}
        onChange={(category) => set({ category })}
      />

      <select
        aria-label={tx("SLA", "المهلة")}
        value={filters.sla}
        onChange={(e) => set({ sla: e.target.value as SlaFilter | "" })}
        style={ctrl}
      >
        <option value="">{tx("Any SLA", "أي مهلة")}</option>
        {SLA_FILTERS.map((v) => (
          <option key={v} value={v}>
            {slaLabels[v]}
          </option>
        ))}
      </select>

      {filtersActive(filters) ? (
        <button
          type="button"
          onClick={() => onChange(EMPTY_BOARD_FILTERS)}
          style={{ ...ctrl, cursor: "pointer", color: "var(--ink-2)", background: "transparent" }}
        >
          {tx("Clear filters", "مسح المرشحات")}
        </button>
      ) : null}
    </div>
  );
}

/** A compact checkbox popover for a multi-value filter ("Priority: Urgent, High"). */
function MultiPick<T extends string>({
  tx,
  label,
  anyLabel,
  options,
  value,
  onChange,
}: {
  tx: Tx;
  label: string;
  anyLabel: string;
  options: ReadonlyArray<readonly [T, string]>;
  value: T[];
  onChange: (v: T[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const chosen = options.filter(([v]) => value.includes(v)).map(([, l]) => l);
  const summary = chosen.length === 0 ? anyLabel : chosen.length <= 2 ? `${label}: ${chosen.join(tx(", ", "، "))}` : `${label}: ${chosen.length}`;
  const toggle = (v: T) => {
    const next = value.includes(v) ? value.filter((x) => x !== v) : [...value, v];
    // Keep the list's order so the hash and the query stay stable.
    onChange(options.map(([o]) => o).filter((o) => next.includes(o)));
  };
  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        style={{ ...ctrl, cursor: "pointer", color: value.length ? "var(--ink)" : "var(--ink-2)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {summary} ▾
      </button>
      {open ? (
        <div
          role="group"
          aria-label={label}
          style={{
            position: "absolute",
            insetInlineStart: 0,
            top: "calc(100% + 4px)",
            zIndex: 41,
            minWidth: 200,
            maxHeight: 300,
            overflowY: "auto",
            background: "var(--bg-1)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,.18)",
            padding: 4,
          }}
        >
          {options.map(([v, l]) => (
            <label
              key={v}
              style={{ display: "flex", alignItems: "center", gap: 8, paddingInline: 8, paddingBlock: 6, fontSize: 12.5, color: "var(--ink)", cursor: "pointer", borderRadius: 6 }}
            >
              <input type="checkbox" checked={value.includes(v)} onChange={() => toggle(v)} />
              <span>{l}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CustomerPicker({ tx, filters, set }: { tx: Tx; filters: Filters; set: (p: Partial<Filters>) => void }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const h = window.setTimeout(() => setDebounced(text), 250);
    return () => window.clearTimeout(h);
  }, [text]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const hits = useContactSearch(debounced);

  if (filters.contactId) {
    return (
      <span style={{ ...ctrl, display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span dir="auto">{filters.contactName || tx("Customer", "العميل")}</span>
        <button
          type="button"
          aria-label={tx("Remove customer filter", "إزالة مرشح العميل")}
          onClick={() => set({ contactId: "", contactName: "" })}
          style={{ background: "transparent", border: 0, color: "var(--ink-3)", cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1 }}
        >
          ×
        </button>
      </span>
    );
  }

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <input
        type="search"
        dir="auto"
        role="combobox"
        aria-expanded={open}
        aria-label={tx("Customer", "العميل")}
        placeholder={tx("Customer…", "العميل…")}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        style={{ ...ctrl, width: 170 }}
      />
      {open && text.trim().length >= 2 ? (
        <div
          role="listbox"
          style={{
            position: "absolute",
            insetInlineStart: 0,
            top: "calc(100% + 4px)",
            zIndex: 41,
            minWidth: 220,
            maxHeight: 260,
            overflowY: "auto",
            background: "var(--bg-1)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,.18)",
            padding: 4,
          }}
        >
          {hits.isFetching && !hits.data ? (
            <div style={{ padding: 8, fontSize: 12, color: "var(--ink-3)" }}>{tx("Searching…", "جارٍ البحث…")}</div>
          ) : (hits.data ?? []).length === 0 ? (
            <div style={{ padding: 8, fontSize: 12, color: "var(--ink-3)" }}>{tx("No matches", "لا توجد نتائج")}</div>
          ) : (
            (hits.data ?? []).map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  set({ contactId: c.id, contactName: c.name });
                  setText("");
                  setOpen(false);
                }}
                style={{ display: "flex", width: "100%", flexDirection: "column", alignItems: "flex-start", gap: 1, padding: "6px 8px", background: "transparent", border: 0, borderRadius: 6, cursor: "pointer", textAlign: "start", color: "var(--ink)" }}
              >
                <span dir="auto" style={{ fontSize: 12.5 }}>{c.name}</span>
                {c.phone ? <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{c.phone}</span> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
