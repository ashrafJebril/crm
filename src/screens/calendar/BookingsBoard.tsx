/**
 * SP-10 bookings board: one column per status (in the lifecycle order),
 * cards with the time in the workspace zone, contact, service colour, staff
 * and the conflict / fit / HJZ badges. Dragging (bookings.update) only lands
 * on allowed columns; the others are dimmed. A refused move (409) reverts,
 * shows the error copy, and reloads the current row.
 */
import { useState, type DragEvent } from "react";
import type { Tx } from "@/lib/tx";
import type { Appointment, AppointmentStatus, Contact, Lang, Service, StaffResource } from "@/lib/types";
import { ColorDot } from "./catalogUi";
import { BookingBadges, serviceLabel } from "./BookingBadges";
import { STATUS_ORDER, STATUS_WORDS, canDrop } from "./bookingStatus";
import { bookingErrorText } from "./bookingErrors";
import { updateBooking } from "./bookingApi";
import { timeInTz, wallClock } from "./bookingTime";

interface Props {
  appts: Appointment[];
  contactById: Map<string, Contact>;
  serviceById: Map<string, Service>;
  staffById: Map<string, StaffResource>;
  tz: string;
  tx: Tx;
  lang: Lang;
  canUpdate: boolean;
  onOpen: (id: string) => void;
  /** Reload after a move (or a refused one). */
  onChanged: () => void;
}

export function BookingsBoard({ appts, contactById, serviceById, staffById, tz, tx, lang, canUpdate, onOpen, onChanged }: Props) {
  const [dragging, setDragging] = useState<Appointment | null>(null);
  const [pending, setPending] = useState<Record<string, AppointmentStatus>>({});
  const [error, setError] = useState<string | null>(null);

  const statusOf = (a: Appointment) => pending[a.id] ?? a.status;

  const drop = async (a: Appointment, to: AppointmentStatus) => {
    if (!canDrop(a.status, to)) return;
    setError(null);
    setPending((p) => ({ ...p, [a.id]: to }));
    try {
      await updateBooking(a.id, { status: to, version: a.version ?? 0 });
    } catch (e) {
      setError(bookingErrorText(e, tx));
    } finally {
      setPending((p) => {
        const n = { ...p };
        delete n[a.id];
        return n;
      });
      onChanged();
    }
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {error && (
        <div role="alert" style={{ color: "var(--bad)", fontSize: 12 }}>
          {error}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${STATUS_ORDER.length}, minmax(200px, 1fr))`, gap: 10, overflowX: "auto" }}>
        {STATUS_ORDER.map((status) => {
          const items = appts.filter((a) => statusOf(a) === status).sort((x, y) => x.startAt.localeCompare(y.startAt));
          const allowed = dragging ? canDrop(dragging.status, status) : true;
          const dimmed = !!dragging && !allowed && dragging.status !== status;
          return (
            <section
              key={status}
              aria-label={tx(...STATUS_WORDS[status])}
              onDragOver={(e: DragEvent) => {
                if (dragging && allowed) e.preventDefault();
              }}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                if (dragging) void drop(dragging, status);
                setDragging(null);
              }}
              style={{
                background: "var(--bg-1)",
                border: `1px ${dragging && allowed && dragging.status !== status ? "dashed var(--accent)" : "solid var(--line-soft)"}`,
                borderRadius: 10,
                padding: 8,
                minHeight: 200,
                opacity: dimmed ? 0.4 : 1,
                display: "grid",
                alignContent: "start",
                gap: 6,
              }}
            >
              <header style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600 }}>
                <span>{tx(...STATUS_WORDS[status])}</span>
                <bdi className="muted">{items.length}</bdi>
              </header>
              {items.map((a) => {
                const svc = a.serviceId ? serviceById.get(a.serviceId) : undefined;
                const res = a.resourceId ? staffById.get(a.resourceId) : undefined;
                const local = wallClock(new Date(a.startAt), tz);
                return (
                  <article
                    key={a.id}
                    draggable={canUpdate && STATUS_ORDER.some((to) => canDrop(a.status, to))}
                    onDragStart={() => setDragging(a)}
                    onDragEnd={() => setDragging(null)}
                    onClick={() => onOpen(a.id)}
                    className="appt-card"
                    style={{
                      background: "var(--bg-0, var(--bg-1))",
                      border: "1px solid var(--line-soft)",
                      borderInlineStart: `3px solid ${a.conflict ? "var(--bad)" : "var(--line)"}`,
                      borderRadius: 8,
                      padding: 8,
                      cursor: "pointer",
                      display: "grid",
                      gap: 4,
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <bdi className="mono" style={{ fontWeight: 600 }}>
                        {local.dateISO.slice(5)} {timeInTz(a.startAt, tz)}
                      </bdi>
                      <bdi className="muted">{a.durationMin}′</bdi>
                    </div>
                    <bdi style={{ fontWeight: 500 }}>{contactById.get(a.contactId)?.name ?? tx("Unknown contact", "عميل غير معروف")}</bdi>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {svc && <ColorDot color={svc.color} />}
                      <bdi>{serviceLabel(a, lang)}</bdi>
                    </div>
                    {res && (
                      <div className="muted">
                        <bdi>{lang === "ar" ? res.nameAr || res.name : res.name}</bdi>
                      </div>
                    )}
                    <BookingBadges appt={a} tx={tx} compact />
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
