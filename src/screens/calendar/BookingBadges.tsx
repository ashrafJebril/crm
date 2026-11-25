/** SP-10 booking flags shared by every view: overlap, schedule fit, HJZ sync. */
import type { Appointment } from "@/lib/types";
import type { Tx } from "@/lib/tx";

const pill = (bg: string, fg: string) =>
  ({
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "1px 6px",
    borderRadius: 999,
    fontSize: 10,
    lineHeight: "16px",
    background: bg,
    color: fg,
    whiteSpace: "nowrap",
  }) as const;

export function BookingBadges({ appt, tx, compact }: { appt: Appointment; tx: Tx; compact?: boolean }) {
  const out = [];
  if (appt.conflict) {
    out.push(
      <span key="c" title={tx("Overlaps another booking", "يتعارض مع حجز آخر")} style={pill("color-mix(in oklch, var(--bad) 16%, transparent)", "var(--bad)")}>
        {compact ? tx("Overlap", "تعارض") : tx("Overlaps another booking", "يتعارض مع حجز آخر")}
      </span>,
    );
  }
  if (appt.fit === "outside_hours" || appt.fit === "off_day") {
    const label = appt.fit === "off_day" ? tx("Day off", "يوم عطلة") : tx("Outside working hours", "خارج ساعات العمل");
    out.push(
      <span key="f" title={label} style={pill("color-mix(in oklch, var(--warn) 18%, transparent)", "var(--warn)")}>
        {compact ? tx("Hours", "الساعات") : label}
      </span>,
    );
  }
  if (appt.hjzSyncError) {
    out.push(
      <span key="h" title={appt.hjzSyncError} style={pill("color-mix(in oklch, var(--warn) 18%, transparent)", "var(--warn)")}>
        {tx("HJZ sync failed", "تعذّرت المزامنة مع HJZ")}
      </span>,
    );
  }
  if (!out.length) return null;
  return <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>{out}</span>;
}

/** The service label of a booking: the catalog row's name when linked, else the snapshot. */
export function serviceLabel(appt: Appointment, lang: "en" | "ar"): string {
  return lang === "ar" ? appt.serviceAr || appt.service : appt.service;
}
