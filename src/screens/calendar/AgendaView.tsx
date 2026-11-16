/**
 * SP-10 agenda: the week's days with booked minutes ("3 h 15 min booked",
 * Latin digits), a line per staff member, and conflicts highlighted. Days and
 * times are in the workspace zone.
 */
import type { Tx } from "@/lib/tx";
import type { Appointment, Contact, Lang, StaffResource, TeamMember } from "@/lib/types";
import { agendaDays, bookedText } from "./agenda";
import { BookingBadges, serviceLabel } from "./BookingBadges";
import { STATUS_WORDS } from "./bookingStatus";
import { hhmm, timeInTz, weekdayOf } from "./bookingTime";
import { dayName } from "./schedule";

interface Props {
  appts: Appointment[];
  days: string[];
  contactById: Map<string, Contact>;
  staffById: Map<string, StaffResource>;
  team: TeamMember[];
  tz: string;
  tx: Tx;
  lang: Lang;
  onOpen: (id: string) => void;
}

export function AgendaView({ appts, days, contactById, staffById, team, tz, tx, lang, onOpen }: Props) {
  const list = agendaDays(appts, tz, days);
  const staffName = (key: string, resourceId: string | null, staffId: string | null) => {
    if (resourceId) {
      const r = staffById.get(resourceId);
      return r ? (lang === "ar" ? r.nameAr || r.name : r.name) : tx("Staff", "موظف");
    }
    if (staffId) return team.find((m) => m.id === staffId)?.name ?? tx("Team member", "عضو الفريق");
    return key === "none" ? tx("Unassigned", "غير مُسند") : key;
  };
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="muted" style={{ fontSize: 11 }}>
        {tx("Times in", "الأوقات بتوقيت")} <bdi>{tz}</bdi>
      </div>
      {list.map((d) => (
        <section key={d.date} className="card" style={{ padding: 12, display: "grid", gap: 8, borderColor: d.conflicts ? "var(--bad)" : undefined }}>
          <header style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14 }}>
              {dayName(weekdayOf(d.date), lang)} <bdi className="mono">{d.date}</bdi>
            </strong>
            <bdi className="muted" style={{ fontSize: 12 }}>
              {bookedText(d.minutes, lang)} · {d.count} {tx("bookings", "حجوزات")}
            </bdi>
            {d.conflicts > 0 && (
              <span style={{ color: "var(--bad)", fontSize: 12 }}>
                {tx("Overlaps", "تعارضات")}: <bdi>{d.conflicts}</bdi>
              </span>
            )}
          </header>
          {d.byResource.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {d.byResource.map((l) => (
                <span key={l.key} className="chip" style={{ fontSize: 11 }}>
                  <bdi>{staffName(l.key, l.resourceId, l.staffId)}</bdi> · <bdi>{bookedText(l.minutes, lang).replace(/ (booked|محجوزة)$/, "")}</bdi>
                </span>
              ))}
            </div>
          )}
          {d.items.length === 0 && <div className="muted" style={{ fontSize: 12 }}>{tx("Nothing booked.", "لا توجد حجوزات.")}</div>}
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
            {d.items.map((a) => {
              const start = timeInTz(a.startAt, tz);
              const endMin = (Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) + a.durationMin) % 1440;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(a.id)}
                    style={{
                      width: "100%",
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      flexWrap: "wrap",
                      textAlign: "start",
                      background: a.conflict ? "color-mix(in oklch, var(--bad) 8%, transparent)" : "transparent",
                      border: 0,
                      borderRadius: 6,
                      padding: "4px 6px",
                      cursor: "pointer",
                      color: "inherit",
                      fontSize: 13,
                    }}
                  >
                    <bdi className="mono" style={{ minWidth: 92 }}>
                      {start}–{hhmm(endMin)}
                    </bdi>
                    <bdi style={{ fontWeight: 500 }}>{contactById.get(a.contactId)?.name ?? "—"}</bdi>
                    <bdi className="muted">{serviceLabel(a, lang)}</bdi>
                    <span className="muted" style={{ fontSize: 11 }}>{tx(...STATUS_WORDS[a.status])}</span>
                    <BookingBadges appt={a} tx={tx} compact />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
