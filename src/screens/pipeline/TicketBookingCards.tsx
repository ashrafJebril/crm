import { useState, type CSSProperties } from "react";
import { useToast } from "@/components/Toast";
import { safeTz } from "@/screens/followups/followupsLogic";
import type { Tx } from "@/lib/tx";
import type { Lang, TicketBookingCard } from "@/lib/types";
import { useSetBookingStatus, useTicketBookings } from "./hooks/useTicketSupport";
import { ticketErrorText } from "./ticketErrors";

const smallBtn: CSSProperties = {
  paddingInline: 10,
  paddingBlock: 4,
  background: "transparent",
  border: "1px solid var(--line)",
  borderRadius: 6,
  color: "var(--ink-2)",
  fontSize: 11.5,
  cursor: "pointer",
};

/** "Tue 17 Nov, 14:30" in the workspace timezone, Latin digits. */
function bookingWhen(iso: string, tz: string, tx: Tx): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(tx("en-GB", "ar-SA-u-nu-latn"), {
    timeZone: safeTz(tz),
    calendar: "gregory",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function statusChip(tx: Tx, status: string): { label: string; color: string } {
  if (status === "confirmed") return { label: tx("Confirmed", "مؤكد"), color: "var(--ok, #10b981)" };
  if (status === "pending") return { label: tx("Pending", "بانتظار"), color: "var(--warn, #f59e0b)" };
  return { label: status, color: "var(--ink-3)" };
}

/**
 * SP-09 booking cards: the ticket contact's upcoming pending and confirmed
 * bookings (bookings.view). Confirm / Cancel need bookings.update and go
 * through the existing PATCH /appointments/:id; hidden otherwise.
 */
export function TicketBookingCards({
  ticketId,
  tx,
  lang,
  tz,
  canUpdate,
}: {
  ticketId: string;
  tx: Tx;
  lang: Lang;
  tz: string;
  canUpdate: boolean;
}) {
  const { toast } = useToast();
  const q = useTicketBookings(ticketId, true);
  const setStatus = useSetBookingStatus(ticketId);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  const act = (b: TicketBookingCard, status: "confirmed" | "cancelled") =>
    setStatus.mutate(
      { id: b.id, status },
      {
        onSuccess: () => {
          setConfirmCancel(null);
          toast(status === "confirmed" ? tx("Booking confirmed", "تم تأكيد الحجز") : tx("Booking cancelled", "تم إلغاء الحجز"), "success");
        },
        onError: (e) => {
          setConfirmCancel(null);
          toast(ticketErrorText(e, tx, tx("Couldn't update the booking.", "تعذّر تحديث الحجز.")), "error");
        },
      },
    );

  if (q.isPending) return <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("Loading…", "جارٍ التحميل…")}</div>;
  if (q.isError)
    return (
      <div role="alert" style={{ fontSize: 12, color: "var(--bad, #ef4444)" }}>
        {ticketErrorText(q.error, tx, tx("Couldn't load bookings.", "تعذّر تحميل الحجوزات."))}
      </div>
    );
  const items = q.data ?? [];
  if (items.length === 0)
    return <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("No upcoming bookings for this customer.", "لا توجد حجوزات قادمة لهذا العميل.")}</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((b) => {
        const chip = statusChip(tx, b.status);
        const service = (lang === "ar" ? b.serviceAr || b.service : b.service || b.serviceAr) || tx("Booking", "حجز");
        const busy = setStatus.isPending && setStatus.variables?.id === b.id;
        return (
          <div
            key={b.id}
            style={{ border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-2)", paddingInline: 12, paddingBlock: 10, display: "flex", flexDirection: "column", gap: 6 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
              <span dir="auto" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>
                {service}
              </span>
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  paddingInline: 6,
                  borderRadius: 999,
                  color: chip.color,
                  border: `1px solid color-mix(in srgb, ${chip.color} 35%, transparent)`,
                  background: `color-mix(in srgb, ${chip.color} 10%, transparent)`,
                }}
              >
                {chip.label}
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ink-2)" }}>
              <bdi>{bookingWhen(b.startAt, tz, tx)}</bdi> · <bdi>{tx(`${b.durationMin} min`, `${b.durationMin} دقيقة`)}</bdi>
            </div>
            {b.hjzSyncError ? (
              <div role="status" style={{ fontSize: 11, color: "var(--warn, #f59e0b)" }}>
                {tx("Not synced to HJZ. The booking system may not have this change.", "لم تتم المزامنة مع HJZ. قد لا يتضمن نظام الحجز هذا التغيير.")}
              </div>
            ) : null}
            {canUpdate ? (
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
                {confirmCancel === b.id ? (
                  <>
                    <span style={{ fontSize: 11, color: "var(--ink-2)" }}>{tx("Cancel this booking?", "إلغاء هذا الحجز؟")}</span>
                    <button type="button" style={smallBtn} onClick={() => setConfirmCancel(null)}>
                      {tx("Keep", "إبقاء")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      style={{ ...smallBtn, color: "white", background: "var(--bad, #ef4444)", borderColor: "transparent" }}
                      onClick={() => act(b, "cancelled")}
                    >
                      {tx("Cancel booking", "إلغاء الحجز")}
                    </button>
                  </>
                ) : (
                  <>
                    {b.status === "pending" ? (
                      <button type="button" disabled={busy} style={{ ...smallBtn, color: "var(--ok, #10b981)" }} onClick={() => act(b, "confirmed")}>
                        {tx("Confirm", "تأكيد")}
                      </button>
                    ) : null}
                    <button type="button" disabled={busy} style={smallBtn} onClick={() => setConfirmCancel(b.id)}>
                      {tx("Cancel", "إلغاء")}
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
