/**
 * SP-10 reschedule (bookings.update): the same slot picker (or a manual time
 * with the live schedule check), sending `version` so a stale edit is 409 with
 * the current row. `resourceId` is sent only when the user picked another
 * staff member (review R-M1). SLOT_TAKEN refreshes the slots and says who
 * took the time.
 */
import { useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { ApiError } from "@/api/client";
import type { Tx } from "@/lib/tx";
import type { Appointment, Lang, Service, StaffResource } from "@/lib/types";
import { reschedulePatch, updateBooking } from "./bookingApi";
import { bookingErrorText, conflictCurrent, errorKey } from "./bookingErrors";
import { hhmm, instantOf, parseHHMM, timeInTz, wallClock } from "./bookingTime";
import { ErrorBox, FIELD, LABEL } from "./catalogUi";
import { manualFit } from "./BookingDialog";
import { SlotPicker, type PickedSlot } from "./SlotPicker";

interface Props {
  appt: Appointment;
  services: Service[];
  staff: StaffResource[];
  tz: string;
  tx: Tx;
  lang: Lang;
  onClose: () => void;
  onSaved: (a: Appointment) => void;
}

export function RescheduleDialog({ appt: initial, services, staff, tz, tx, lang, onClose, onSaved }: Props) {
  const [appt, setAppt] = useState(initial);
  const service = services.find((s) => s.id === appt.serviceId);
  const staffById = useMemo(() => new Map(staff.map((r) => [r.id, r])), [staff]);
  const start = wallClock(new Date(appt.startAt), tz);
  const [date, setDate] = useState(start.dateISO);
  const [resourceId, setResourceId] = useState<string>(appt.resourceId ?? "");
  const [staffTouched, setStaffTouched] = useState(false);
  const [slot, setSlot] = useState<PickedSlot | null>(null);
  const [manual, setManual] = useState(!service);
  const [time, setTime] = useState(hhmm(start.minutes));
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const offering = staff.filter((r) => r.active && !r.archivedAt && (!service || r.serviceIds.includes(service.id)));
  const chosen = resourceId ? staffById.get(resourceId) : undefined;
  const fit = manual ? manualFit(chosen, date, time, appt.durationMin, tz) : null;
  const fitBlocks = fit !== null && fit.kind !== "ok";
  const ready = !busy && (manual ? parseHHMM(time) !== null && !fitBlocks : !!slot);

  const save = async () => {
    setBusy(true);
    setError(null);
    const startAt = manual ? instantOf(date, parseHHMM(time) as number, tz).toISOString() : (slot as PickedSlot).startAt;
    // Only an explicit staff change sends resourceId (omit = unchanged, null = drop it).
    const picked = manual ? resourceId || null : (slot as PickedSlot).resourceId;
    const body = reschedulePatch(appt, { startAt, ...(staffTouched ? { resourceId: picked } : {}) });
    try {
      onSaved(await updateBooking(appt.id, body));
    } catch (e) {
      const current = conflictCurrent<Appointment>(e);
      if (current) {
        setAppt(current);
        setError(tx("Someone else changed this booking. It now shows their version; choose the time again.", "عدّل شخص آخر هذا الحجز. يظهر الآن بنسختهم؛ اختر الوقت مجددًا."));
      } else if (e instanceof ApiError && errorKey(e) === "SLOT_TAKEN") {
        const c = (e.body as { conflict?: { startAt?: string; durationMin?: number } } | undefined)?.conflict;
        setSlot(null);
        setRefresh((n) => n + 1);
        setError(
          c?.startAt
            ? tx(
                `That time was just taken by a booking at ${timeInTz(c.startAt, tz)} (${c.durationMin ?? ""} min). Pick another slot.`,
                `حُجز هذا الوقت للتو بموعد في ${timeInTz(c.startAt, tz)} (${c.durationMin ?? ""} دقيقة). اختر وقتًا آخر.`,
              )
            : bookingErrorText(e, tx),
        );
      } else {
        setError(bookingErrorText(e, tx));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} width={540} label={tx("Reschedule", "إعادة الجدولة")}>
      <form
        dir={lang === "ar" ? "rtl" : "ltr"}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void save();
        }}
        style={{ display: "grid", gap: 12, maxHeight: "80vh", overflowY: "auto" }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>{tx("Reschedule", "إعادة الجدولة")}</h3>
        <div style={{ fontSize: 13 }}>
          <bdi style={{ fontWeight: 500 }}>{lang === "ar" ? appt.serviceAr || appt.service : appt.service}</bdi>{" "}
          <span className="muted">
            · {tx("now", "حاليًا")} <bdi className="mono">{start.dateISO} {hhmm(start.minutes)}</bdi>
          </span>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
          <label>
            <span style={LABEL}>{tx("Date", "التاريخ")}</span>
            <input
              type="date"
              style={FIELD}
              value={date}
              onChange={(e) => {
                if (e.target.value) setDate(e.target.value);
                setSlot(null);
              }}
            />
          </label>
          <label>
            <span style={LABEL}>{tx("Staff", "الموظف")}</span>
            <select
              style={FIELD}
              value={resourceId}
              onChange={(e) => {
                setResourceId(e.target.value);
                setStaffTouched(e.target.value !== (appt.resourceId ?? ""));
                setSlot(null);
              }}
            >
              <option value="">{service ? tx("Any available", "أي موظف متاح") : tx("Not set", "غير محدد")}</option>
              {offering.map((r) => (
                <option key={r.id} value={r.id}>
                  {lang === "ar" ? r.nameAr || r.name : r.name}
                </option>
              ))}
            </select>
          </label>
          {service && (
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
              <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
              {tx("Enter a time myself", "إدخال الوقت يدويًا")}
            </label>
          )}
        </div>
        {!manual && service && (
          <SlotPicker
            serviceId={service.id}
            resourceId={resourceId || null}
            date={date}
            tz={tz}
            tx={tx}
            lang={lang}
            staffById={staffById}
            value={slot}
            onChange={setSlot}
            refreshKey={refresh}
          />
        )}
        {manual && (
          <div style={{ display: "grid", gap: 6 }}>
            <label>
              <span style={LABEL}>
                {tx("Time", "الوقت")} (<bdi>{tz}</bdi>)
              </span>
              <input style={{ ...FIELD, width: 90, direction: "ltr" }} value={time} maxLength={5} onChange={(e) => setTime(e.target.value)} />
            </label>
            {fitBlocks && fit && (
              <div role="alert" style={{ color: "var(--warn)", fontSize: 12 }}>
                {bookingErrorText(new ApiError("bookings.outside_schedule", 422, undefined, { message: "bookings.outside_schedule", fit }), tx)}
              </div>
            )}
          </div>
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="submit" className="btn primary" disabled={!ready}>
            {busy ? tx("Saving…", "جارٍ الحفظ…") : tx("Reschedule", "إعادة الجدولة")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
