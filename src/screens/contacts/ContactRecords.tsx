import { useState } from "react";
import { useFetch } from "@/api/useFetch";
import type { Tx } from "@/lib/tx";
import type { Appointment, Lang } from "@/lib/types";
import { Pager } from "./Pager";

const PAGE_SIZES = [10, 25, 50];

interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

interface TicketRow {
  id: string;
  number: number;
  title: string;
  // Prisma Decimal arrives as a string.
  value: string | number | null;
  currency: string;
  closedAt: string | null;
  stage: { label: string; color: string } | null;
}

const STAGE_COLOR_VAR: Record<string, string> = {
  ink: "var(--ink-3)",
  info: "var(--info)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  bad: "var(--bad)",
  accent: "var(--accent)",
  human: "var(--info)",
};

const APPT_STATUS: Record<string, { en: string; ar: string }> = {
  confirmed: { en: "Confirmed", ar: "مؤكد" },
  pending: { en: "Pending", ar: "قيد الانتظار" },
  completed: { en: "Completed", ar: "مكتمل" },
  cancelled: { en: "Cancelled", ar: "ملغى" },
  "no-show": { en: "No-show", ar: "لم يحضر" },
};

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 10px",
  background: "var(--bg-1)",
  border: "1px solid var(--line-soft)",
  borderRadius: 8,
};

/** Paged tickets and bookings for one contact (10 per page by default). */
export function ContactRecords({
  tx,
  lang,
  contactId,
  onOpenTicket,
}: {
  tx: Tx;
  lang: Lang;
  contactId: string;
  onOpenTicket: () => void;
}) {
  return (
    <>
      <RecordList<TicketRow>
        tx={tx}
        contactId={contactId}
        kind="tickets"
        label={tx("Tickets", "التذاكر")}
        empty={tx("No tickets yet.", "لا توجد تذاكر بعد.")}
        render={(rt) => {
          const accent = rt.stage ? (STAGE_COLOR_VAR[rt.stage.color] ?? "var(--ink-3)") : "var(--ink-3)";
          const value = rt.value === null || rt.value === "" ? null : Number(rt.value);
          return (
            <button
              key={rt.id}
              type="button"
              onClick={onOpenTicket}
              style={{ ...ROW, width: "100%", textAlign: "start", cursor: "pointer", color: "var(--ink)", fontFamily: "inherit" }}
            >
              <span aria-hidden style={{ width: 3, height: 22, background: accent, borderRadius: 2, flex: "0 0 auto" }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                    #{String(rt.number).padStart(3, "0")}
                  </span>
                  <span
                    dir="auto"
                    style={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {rt.title}
                  </span>
                </span>
                <span style={{ display: "flex", gap: 8, marginTop: 3, fontSize: 11, color: "var(--ink-3)" }}>
                  {rt.stage && <span style={{ color: accent }}>{rt.stage.label}</span>}
                  {value !== null && Number.isFinite(value) && (
                    <span className="mono">
                      {rt.currency} {value.toLocaleString()}
                    </span>
                  )}
                </span>
              </span>
            </button>
          );
        }}
      />
      <RecordList<Appointment>
        tx={tx}
        contactId={contactId}
        kind="appointments"
        label={tx("Bookings", "الحجوزات")}
        empty={tx("No bookings yet.", "لا توجد حجوزات بعد.")}
        render={(ap) => {
          const st = APPT_STATUS[ap.status];
          const when = new Date(ap.startAt);
          return (
            <div key={ap.id} style={ROW}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span dir="auto" style={{ display: "block", fontSize: 13, fontWeight: 500, overflowWrap: "anywhere" }}>
                  {(lang === "ar" && ap.serviceAr) || ap.service}
                </span>
                <span className="mono" style={{ display: "block", fontSize: 11, color: "var(--ink-3)", marginTop: 3 }}>
                  {Number.isNaN(when.getTime())
                    ? ap.startAt
                    : when.toLocaleString(lang === "ar" ? "ar" : "en-US", { dateStyle: "medium", timeStyle: "short" })}
                  {" · "}
                  {st ? (lang === "ar" ? st.ar : st.en) : ap.status}
                </span>
              </span>
            </div>
          );
        }}
      />
    </>
  );
}

function RecordList<T>({
  tx,
  contactId,
  kind,
  label,
  empty,
  render,
}: {
  tx: Tx;
  contactId: string;
  kind: "tickets" | "appointments";
  label: string;
  empty: string;
  render: (item: T) => React.ReactNode;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const q = useFetch<Paged<T>>(`/contacts/${contactId}/${kind}?page=${page}&pageSize=${pageSize}`);
  const d = q.data;

  return (
    <div style={{ marginTop: 18 }}>
      <div
        className="mono"
        style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06, marginBottom: 8 }}
      >
        {label}
        {d ? ` (${d.total.toLocaleString()})` : ""}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {q.error && !d ? (
          <div role="alert" style={{ fontSize: 11.5, color: "var(--bad)" }}>
            {q.error}
          </div>
        ) : !d ? (
          <div className="muted" style={{ fontSize: 11 }}>
            {tx("Loading…", "جارٍ التحميل…")}
          </div>
        ) : d.total === 0 ? (
          <div className="mono muted" style={{ fontSize: 11, opacity: 0.7 }}>
            {empty}
          </div>
        ) : (
          d.items.map(render)
        )}
      </div>
      {d && d.total > 0 && (
        <Pager
          tx={tx}
          page={d.page}
          pageCount={d.pageCount}
          pageSize={pageSize}
          total={d.total}
          pageSizes={PAGE_SIZES}
          navLabel={label}
          busy={q.loading}
          onPage={setPage}
          onPageSize={(n) => {
            setPageSize(n);
            setPage(1);
          }}
        />
      )}
    </div>
  );
}
