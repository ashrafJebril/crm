/**
 * SP-10 new booking (bookings.create): contact, catalog service, staff "Any"
 * or one, date, and a free slot from GET /bookings/availability, or a manual
 * time with the live schedule check (submit is disabled on a day off or
 * outside hours, like the server's gate). A free-text mode stays for services
 * not in the catalog. Times are in the workspace zone.
 */
import { useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { ApiError } from "@/api/client";
import type { Tx } from "@/lib/tx";
import type { Contact, Lang, Service, StaffResource } from "@/lib/types";
import { createBooking, type NewBookingInput } from "./bookingApi";
import { bookingErrorText, errorKey } from "./bookingErrors";
import { instantOf, parseHHMM, wallClock } from "./bookingTime";
import { ErrorBox, FIELD, LABEL } from "./catalogUi";
import { scheduleFitAt, type FitResult } from "./schedule";
import { SlotPicker, type PickedSlot } from "./SlotPicker";

interface Props {
  contacts: Contact[];
  services: Service[];
  staff: StaffResource[];
  tz: string;
  tx: Tx;
  lang: Lang;
  /** Workspace-local date to start on. */
  date: string;
  onClose: () => void;
  onCreated: () => void;
}

type Mode = "catalog" | "free";

/** The live manual-time check (null when there is nothing to check). */
export function manualFit(resource: StaffResource | undefined, date: string, time: string, durationMin: number, tz: string): FitResult | null {
  const min = parseHHMM(time);
  if (!resource || min === null || min >= 1440 || !durationMin) return null;
  return scheduleFitAt(resource.schedule, instantOf(date, min, tz), durationMin, tz);
}

export function BookingDialog({ contacts, services, staff, tz, tx, lang, date: initialDate, onClose, onCreated }: Props) {
  const active = useMemo(() => services.filter((s) => s.active && !s.archivedAt), [services]);
  const [mode, setMode] = useState<Mode>(active.length ? "catalog" : "free");
  const [contactId, setContactId] = useState(contacts[0]?.id ?? "");
  const [serviceId, setServiceId] = useState(active[0]?.id ?? "");
  const [resourceId, setResourceId] = useState<string>("");
  const [date, setDate] = useState(initialDate);
  const [slot, setSlot] = useState<PickedSlot | null>(null);
  const [manual, setManual] = useState(false);
  const [time, setTime] = useState("09:00");
  const [status, setStatus] = useState<"confirmed" | "pending">("confirmed");
  const [freeService, setFreeService] = useState("");
  const [freeServiceAr, setFreeServiceAr] = useState("");
  const [freeDuration, setFreeDuration] = useState("30");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const service = active.find((s) => s.id === serviceId);
  const offering = useMemo(
    () => staff.filter((r) => r.active && !r.archivedAt && (!service || r.serviceIds.includes(service.id))),
    [staff, service],
  );
  const staffById = useMemo(() => new Map(staff.map((r) => [r.id, r])), [staff]);
  const chosen = resourceId ? staffById.get(resourceId) : undefined;
  const fit = mode === "catalog" && manual ? manualFit(chosen, date, time, service?.durationMin ?? 0, tz) : null;
  const fitBlocks = fit !== null && fit.kind !== "ok";

  const ready =
    !!contactId &&
    !busy &&
    (mode === "catalog"
      ? !!service && (manual ? !!chosen && parseHHMM(time) !== null && !fitBlocks : !!slot)
      : !!freeService.trim() && /^\d+$/.test(freeDuration) && Number(freeDuration) >= 1 && Number(freeDuration) <= 1440 && parseHHMM(time) !== null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    let body: NewBookingInput;
    if (mode === "catalog" && service) {
      const startAt = manual ? instantOf(date, parseHHMM(time) as number, tz).toISOString() : (slot as PickedSlot).startAt;
      const res = manual ? resourceId : (slot as PickedSlot).resourceId;
      body = { contactId, serviceId: service.id, resourceId: res || undefined, startAt, status, source: "human" };
    } else {
      body = {
        contactId,
        service: freeService.trim(),
        serviceAr: freeServiceAr.trim() || freeService.trim(),
        startAt: instantOf(date, parseHHMM(time) as number, tz).toISOString(),
        durationMin: Number(freeDuration),
        status,
        source: "human",
      };
    }
    try {
      await createBooking(body);
      onCreated();
    } catch (e) {
      setError(bookingErrorText(e, tx));
      if (e instanceof ApiError && errorKey(e) === "SLOT_TAKEN") {
        setSlot(null);
        setRefresh((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} width={560} label={tx("New booking", "حجز جديد")}>
      <form
        dir={lang === "ar" ? "rtl" : "ltr"}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
        style={{ display: "grid", gap: 12, maxHeight: "80vh", overflowY: "auto" }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>{tx("New booking", "حجز جديد")}</h3>
        <div className="tabs" role="tablist" style={{ padding: 0, border: 0 }}>
          <button type="button" role="tab" aria-selected={mode === "catalog"} disabled={!active.length} className={`tab ${mode === "catalog" ? "active" : ""}`.trim()} onClick={() => setMode("catalog")}>
            {tx("Catalog service", "خدمة من الكتالوج")}
          </button>
          <button type="button" role="tab" aria-selected={mode === "free"} className={`tab ${mode === "free" ? "active" : ""}`.trim()} onClick={() => setMode("free")}>
            {tx("Other service", "خدمة أخرى")}
          </button>
        </div>
        <label>
          <span style={LABEL}>{tx("Contact", "العميل")}</span>
          <select style={{ ...FIELD, width: "100%" }} value={contactId} onChange={(e) => setContactId(e.target.value)}>
            {!contacts.length && <option value="">{tx("No contacts", "لا توجد جهات اتصال")}</option>}
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.phone ? ` — ${c.phone}` : ""}
              </option>
            ))}
          </select>
        </label>

        {mode === "catalog" ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label>
                <span style={LABEL}>{tx("Service", "الخدمة")}</span>
                <select
                  style={{ ...FIELD, width: "100%" }}
                  value={serviceId}
                  onChange={(e) => {
                    setServiceId(e.target.value);
                    setSlot(null);
                    setResourceId("");
                  }}
                >
                  {active.map((s) => (
                    <option key={s.id} value={s.id}>
                      {lang === "ar" ? s.nameAr : s.name} ({s.durationMin} {tx("min", "د")})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span style={LABEL}>{tx("Staff", "الموظف")}</span>
                <select
                  style={{ ...FIELD, width: "100%" }}
                  value={resourceId}
                  onChange={(e) => {
                    setResourceId(e.target.value);
                    setSlot(null);
                  }}
                >
                  <option value="">{tx("Any available", "أي موظف متاح")}</option>
                  {offering.map((r) => (
                    <option key={r.id} value={r.id}>
                      {lang === "ar" ? r.nameAr || r.name : r.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
              <label>
                <span style={LABEL}>{tx("Date", "التاريخ")}</span>
                <input
                  type="date"
                  style={{ ...FIELD }}
                  value={date}
                  onChange={(e) => {
                    if (e.target.value) setDate(e.target.value);
                    setSlot(null);
                  }}
                />
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
                {tx("Enter a time myself", "إدخال الوقت يدويًا")}
              </label>
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
                  <input style={{ ...FIELD, width: 90, direction: "ltr" }} value={time} maxLength={5} placeholder="09:00" onChange={(e) => setTime(e.target.value)} />
                </label>
                {!chosen && <div className="muted" style={{ fontSize: 12 }}>{tx("Choose a staff member to enter a time.", "اختر موظفًا لإدخال الوقت.")}</div>}
                {fitBlocks && fit && (
                  <div role="alert" style={{ color: "var(--warn)", fontSize: 12 }}>
                    {bookingErrorText(new ApiError("bookings.outside_schedule", 422, undefined, { message: "bookings.outside_schedule", fit }), tx)}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label>
                <span style={LABEL}>{tx("Service (English)", "الخدمة (بالإنجليزية)")}</span>
                <input style={{ ...FIELD, width: "100%" }} dir="ltr" value={freeService} onChange={(e) => setFreeService(e.target.value)} />
              </label>
              <label>
                <span style={LABEL}>{tx("Service (Arabic)", "الخدمة (بالعربية)")}</span>
                <input style={{ ...FIELD, width: "100%" }} dir="rtl" value={freeServiceAr} onChange={(e) => setFreeServiceAr(e.target.value)} />
              </label>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <label>
                <span style={LABEL}>{tx("Date", "التاريخ")}</span>
                <input type="date" style={FIELD} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
              </label>
              <label>
                <span style={LABEL}>
                  {tx("Time", "الوقت")} (<bdi>{tz}</bdi>)
                </span>
                <input style={{ ...FIELD, width: 90, direction: "ltr" }} value={time} maxLength={5} onChange={(e) => setTime(e.target.value)} />
              </label>
              <label>
                <span style={LABEL}>{tx("Duration (min)", "المدة (دقيقة)")}</span>
                <input style={{ ...FIELD, width: 90, direction: "ltr" }} inputMode="numeric" value={freeDuration} onChange={(e) => setFreeDuration(e.target.value)} />
              </label>
            </div>
          </>
        )}

        <label>
          <span style={LABEL}>{tx("Status", "الحالة")}</span>
          <select style={{ ...FIELD, width: 200 }} value={status} onChange={(e) => setStatus(e.target.value as "confirmed" | "pending")}>
            <option value="confirmed">{tx("Confirmed", "مؤكد")}</option>
            <option value="pending">{tx("Pending", "قيد الانتظار")}</option>
          </select>
        </label>
        {error && <ErrorBox>{error}</ErrorBox>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="submit" className="btn primary" disabled={!ready}>
            {busy ? tx("Saving…", "جارٍ الحفظ…") : tx("Book", "حجز")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Today's workspace-local date. */
export const todayIn = (tz: string) => wallClock(new Date(), tz).dateISO;
