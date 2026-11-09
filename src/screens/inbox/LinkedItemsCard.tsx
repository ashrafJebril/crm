import { useFetch } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import { openRecord } from "@/lib/openRecord";
import type { Tx } from "@/lib/tx";
import type { Appointment, Lang } from "@/lib/types";

interface Paged<T> {
  items: T[];
  total: number;
}

interface TicketRow {
  id: string;
  number: number;
  title: string;
  value: string | number | null;
  currency: string;
  stage: { label: string; color: string } | null;
}

const STATUS: Record<string, [string, string]> = {
  confirmed: ["Confirmed", "مؤكد"],
  pending: ["Pending", "قيد الانتظار"],
  completed: ["Completed", "مكتمل"],
  cancelled: ["Cancelled", "ملغى"],
  "no-show": ["No-show", "لم يحضر"],
};

const SHOWN = 5;

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--line-soft)",
  background: "var(--bg-2)",
  color: "var(--ink-1)",
  fontFamily: "inherit",
  textAlign: "start" as const,
  cursor: "pointer",
};

const Label = ({ children }: { children: string }) => (
  <div
    style={{
      fontSize: 10,
      fontFamily: "var(--font-mono)",
      textTransform: "uppercase",
      letterSpacing: 0.08,
      color: "var(--ink-3)",
    }}
  >
    {children}
  </div>
);

/** Details-panel card: the contact's tickets and bookings, each opening in the
 *  record sheet. A section only renders when the viewer may see that record type. */
export function LinkedItemsCard({ contactId, lang, tx }: { contactId: string; lang: Lang; tx: Tx }) {
  const { can } = usePermissions();
  const canTickets = can("tickets.view");
  const canBookings = can("bookings.view");
  const ticketsQ = useFetch<Paged<TicketRow>>(
    canTickets ? `/contacts/${contactId}/tickets?page=1&pageSize=${SHOWN}` : null,
  );
  const apptsQ = useFetch<Paged<Appointment>>(
    canBookings ? `/contacts/${contactId}/appointments?page=1&pageSize=${SHOWN}` : null,
  );
  if (!canTickets && !canBookings) return null;

  const empty = (text: string) => (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        background: "var(--bg-2)",
        border: "1px dashed var(--line-soft)",
        fontSize: 12,
        color: "var(--ink-3)",
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
  const more = (total: number) =>
    total > SHOWN ? (
      <div className="muted" style={{ fontSize: 11, textAlign: "center" }}>
        {tx(`+${total - SHOWN} more`, `+${total - SHOWN} أخرى`)}
      </div>
    ) : null;

  const tickets = ticketsQ.data?.items ?? [];
  const appts = apptsQ.data?.items ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {canTickets && !ticketsQ.error && (
        <div>
          <Label>{tx("Tickets", "التذاكر")}</Label>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {ticketsQ.data === null
              ? <div className="mono muted" style={{ fontSize: 11 }}>{tx("loading…", "جارٍ التحميل…")}</div>
              : tickets.length === 0
                ? empty(tx("No tickets yet", "لا توجد تذاكر"))
                : tickets.map((t) => (
                    <button key={t.id} type="button" style={rowStyle} onClick={() => openRecord("ticket", t.id)}>
                      <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", flex: "0 0 auto" }}>#{t.number}</span>
                      <span
                        dir="auto"
                        title={t.title}
                        style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {t.title}
                      </span>
                      {t.stage && <span style={{ fontSize: 11, color: "var(--ink-3)", flex: "0 0 auto" }}>{t.stage.label}</span>}
                    </button>
                  ))}
            {more(ticketsQ.data?.total ?? 0)}
          </div>
        </div>
      )}
      {canBookings && !apptsQ.error && (
        <div>
          <Label>{tx("Bookings", "الحجوزات")}</Label>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {apptsQ.data === null
              ? <div className="mono muted" style={{ fontSize: 11 }}>{tx("loading…", "جارٍ التحميل…")}</div>
              : appts.length === 0
                ? empty(tx("No bookings yet", "لا توجد حجوزات"))
                : appts.map((a) => {
                    const when = new Date(a.startAt);
                    const st = STATUS[a.status];
                    return (
                      <button key={a.id} type="button" style={rowStyle} onClick={() => openRecord("booking", a.id)}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span dir="auto" style={{ display: "block", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {(lang === "ar" && a.serviceAr) || a.service}
                          </span>
                          <span className="mono" style={{ display: "block", fontSize: 10.5, color: "var(--ink-3)" }}>
                            {Number.isNaN(when.getTime())
                              ? a.startAt
                              : when.toLocaleString(lang === "ar" ? "ar" : "en-US", { dateStyle: "medium", timeStyle: "short" })}
                            {st ? ` · ${lang === "ar" ? st[1] : st[0]}` : ""}
                          </span>
                        </span>
                      </button>
                    );
                  })}
            {more(apptsQ.data?.total ?? 0)}
          </div>
        </div>
      )}
    </div>
  );
}
