/** SP-10 "New service" / "Edit service" dialog (`dir` set; writes need bookings.manage). */
import { useState } from "react";
import { Modal } from "@/components/Modal";
import { Toggle } from "@/components/Toggle";
import type { Tx } from "@/lib/tx";
import type { Lang, Service, StaffResource } from "@/lib/types";
import { PRICE_PATTERN, SERVICE_DURATION_MAX, SERVICE_DURATION_MIN } from "./bookingConstants";
import { bookingErrorText, conflictCurrent } from "./bookingErrors";
import { createService, setServiceStaff, updateService, type ServiceInput } from "./catalogApi";
import { ColorPicker, ConflictBanner, ErrorBox, FIELD, LABEL } from "./catalogUi";

interface Props {
  service: Service | null;
  staff: StaffResource[];
  tx: Tx;
  lang: Lang;
  onClose: () => void;
  onSaved: (s: Service) => void;
}

interface Form {
  name: string;
  nameAr: string;
  durationMin: string;
  price: string;
  currency: string;
  color: string;
  active: boolean;
  staffIds: string[];
}

const formOf = (s: Service | null): Form => ({
  name: s?.name ?? "",
  nameAr: s?.nameAr ?? "",
  durationMin: String(s?.durationMin ?? 60),
  price: s?.price ?? "",
  currency: s?.currency ?? "SAR",
  color: s?.color ?? "info",
  active: s?.active ?? true,
  staffIds: s?.staffIds ?? [],
});

export function ServiceDialog({ service, staff, tx, lang, onClose, onSaved }: Props) {
  const [form, setForm] = useState<Form>(() => formOf(service));
  const [version, setVersion] = useState(service?.version ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Service | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const duration = Number(form.durationMin);
  const fieldErr = {
    name: !form.name.trim() && !form.nameAr.trim(),
    duration: !/^\d+$/.test(form.durationMin) || duration < SERVICE_DURATION_MIN || duration > SERVICE_DURATION_MAX,
    price: form.price.trim() !== "" && !PRICE_PATTERN.test(form.price.trim()),
    currency: !/^[A-Za-z]{3}$/.test(form.currency.trim()),
  };
  const invalid = Object.values(fieldErr).some(Boolean);
  const archived = !!service?.archivedAt;

  const save = async (withVersion = version) => {
    setBusy(true);
    setError(null);
    setConflict(null);
    const body: ServiceInput = {
      name: form.name.trim() || form.nameAr.trim(),
      nameAr: form.nameAr.trim() || form.name.trim(),
      durationMin: duration,
      price: form.price.trim() || null,
      currency: form.currency.trim().toUpperCase(),
      color: form.color,
    };
    try {
      let saved: Service;
      if (!service) {
        saved = await createService({ ...body, staffIds: form.staffIds });
      } else {
        saved = await updateService(service.id, { ...body, ...(archived ? {} : { active: form.active }), version: withVersion });
        const before = [...service.staffIds].sort().join();
        if ([...form.staffIds].sort().join() !== before) saved = await setServiceStaff(service.id, form.staffIds);
      }
      onSaved(saved);
    } catch (e) {
      const current = conflictCurrent<Service>(e);
      if (current) setConflict(current);
      else setError(bookingErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const activeStaff = staff.filter((r) => !r.archivedAt || form.staffIds.includes(r.id));

  return (
    <Modal onClose={onClose} width={520} label={service ? tx("Edit service", "تعديل الخدمة") : tx("New service", "خدمة جديدة")}>
      <form
        dir={lang === "ar" ? "rtl" : "ltr"}
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid && !busy) void save();
        }}
        style={{ display: "grid", gap: 12 }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>{service ? tx("Edit service", "تعديل الخدمة") : tx("New service", "خدمة جديدة")}</h3>
        {conflict && (
          <ConflictBanner
            tx={tx}
            onLoadTheirs={() => {
              setForm(formOf(conflict));
              setVersion(conflict.version);
              setConflict(null);
            }}
            onKeepMine={() => {
              setVersion(conflict.version);
              void save(conflict.version);
            }}
          />
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label>
            <span style={LABEL}>{tx("Name (English)", "الاسم (بالإنجليزية)")}</span>
            <input style={{ ...FIELD, width: "100%" }} dir="ltr" value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} />
          </label>
          <label>
            <span style={LABEL}>{tx("Name (Arabic)", "الاسم (بالعربية)")}</span>
            <input style={{ ...FIELD, width: "100%" }} dir="rtl" value={form.nameAr} maxLength={120} onChange={(e) => set("nameAr", e.target.value)} />
          </label>
        </div>
        {fieldErr.name && <div style={{ color: "var(--bad)", fontSize: 12 }}>{tx("Enter a name in either language.", "أدخل اسمًا بأي من اللغتين.")}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <label>
            <span style={LABEL}>{tx("Duration (minutes)", "المدة (بالدقائق)")}</span>
            <input
              style={{ ...FIELD, width: "100%", borderColor: fieldErr.duration ? "var(--bad)" : undefined }}
              dir="ltr"
              inputMode="numeric"
              value={form.durationMin}
              onChange={(e) => set("durationMin", e.target.value)}
            />
          </label>
          <label>
            <span style={LABEL}>{tx("Price", "السعر")}</span>
            <input
              style={{ ...FIELD, width: "100%", borderColor: fieldErr.price ? "var(--bad)" : undefined }}
              dir="ltr"
              inputMode="decimal"
              placeholder="120.00"
              value={form.price}
              onChange={(e) => set("price", e.target.value)}
            />
          </label>
          <label>
            <span style={LABEL}>{tx("Currency", "العملة")}</span>
            <input
              style={{ ...FIELD, width: "100%", borderColor: fieldErr.currency ? "var(--bad)" : undefined }}
              dir="ltr"
              maxLength={3}
              value={form.currency}
              onChange={(e) => set("currency", e.target.value.toUpperCase())}
            />
          </label>
        </div>
        {fieldErr.duration && (
          <div style={{ color: "var(--bad)", fontSize: 12 }}>
            {tx(`Duration must be between ${SERVICE_DURATION_MIN} and ${SERVICE_DURATION_MAX} minutes.`, `يجب أن تكون المدة بين ${SERVICE_DURATION_MIN} و${SERVICE_DURATION_MAX} دقيقة.`)}
          </div>
        )}
        {fieldErr.price && <div style={{ color: "var(--bad)", fontSize: 12 }}>{tx("Enter a price such as 120 or 120.50.", "أدخل سعرًا مثل 120 أو 120.50.")}</div>}
        <div>
          <span style={LABEL}>{tx("Colour", "اللون")}</span>
          <ColorPicker value={form.color} onChange={(c) => set("color", c)} tx={tx} />
        </div>
        <div>
          <span style={LABEL}>{tx("Staff who provide it", "الموظفون الذين يقدمونها")}</span>
          {activeStaff.length === 0 && <div className="muted" style={{ fontSize: 12 }}>{tx("No staff yet. Add staff in the Staff tab.", "لا يوجد موظفون بعد. أضفهم من تبويب الموظفين.")}</div>}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {activeStaff.map((r) => {
              const on = form.staffIds.includes(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={on}
                  className={`cal-chip ${on ? "active" : ""}`.trim()}
                  onClick={() => set("staffIds", on ? form.staffIds.filter((x) => x !== r.id) : [...form.staffIds, r.id])}
                >
                  <bdi>{lang === "ar" ? r.nameAr || r.name : r.name}</bdi>
                </button>
              );
            })}
          </div>
        </div>
        {service && !archived && (
          <Toggle on={form.active} onChange={(v) => set("active", v)} label={tx("Takes new bookings", "تقبل حجوزات جديدة")} />
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="submit" className="btn primary" disabled={invalid || busy}>
            {busy ? tx("Saving…", "جارٍ الحفظ…") : tx("Save", "حفظ")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
