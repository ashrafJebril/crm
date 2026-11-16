/**
 * SP-10 "New staff" / "Edit staff" dialog: names EN/AR, role, colour, the
 * member link (from the workspace members), services, and the weekly schedule
 * editor. Version 409 → "Load theirs / Keep mine"; a server
 * `bookings.schedule_invalid` is shown on the exact row.
 */
import { useReducer, useState } from "react";
import { Modal } from "@/components/Modal";
import { Toggle } from "@/components/Toggle";
import type { Tx } from "@/lib/tx";
import type { Lang, Service, StaffResource, TeamMember } from "@/lib/types";
import { ApiError } from "@/api/client";
import { bookingErrorText, conflictCurrent, errorKey } from "./bookingErrors";
import { createStaff, setStaffServices, updateStaff, type StaffInput } from "./catalogApi";
import { ColorPicker, ConflictBanner, ErrorBox, FIELD, LABEL } from "./catalogUi";
import { WeeklyScheduleEditor } from "./WeeklyScheduleEditor";
import { dayErrors, fromSchedule, reduce, serverError, toSchedule } from "./scheduleEditor";
import type { Weekday } from "./bookingTime";
import type { ScheduleError } from "./schedule";

interface Props {
  resource: StaffResource | null;
  services: Service[];
  members: TeamMember[];
  /** Members that already have a staff profile (other than this one). */
  takenUserIds: Set<string>;
  tx: Tx;
  lang: Lang;
  tz: string;
  onClose: () => void;
  onSaved: (r: StaffResource) => void;
}

interface Form {
  name: string;
  nameAr: string;
  role: string;
  color: string;
  userId: string;
  active: boolean;
  serviceIds: string[];
}

const formOf = (r: StaffResource | null): Form => ({
  name: r?.name ?? "",
  nameAr: r?.nameAr ?? "",
  role: r?.role ?? "",
  color: r?.color ?? "accent",
  userId: r?.userId ?? "",
  active: r?.active ?? true,
  serviceIds: r?.serviceIds ?? [],
});

export function StaffDialog({ resource, services, members, takenUserIds, tx, lang, tz, onClose, onSaved }: Props) {
  const [form, setForm] = useState<Form>(() => formOf(resource));
  const [model, dispatch] = useReducer(reduce, resource?.schedule ?? {}, fromSchedule);
  const [version, setVersion] = useState(resource?.version ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Partial<Record<Weekday, ScheduleError>> | null>(null);
  const [conflict, setConflict] = useState<StaffResource | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const localErrors = dayErrors(model);
  const errors = Object.keys(localErrors).length ? localErrors : serverErrors ?? {};
  const invalid = !form.name.trim() || Object.keys(localErrors).length > 0;
  const archived = !!resource?.archivedAt;

  const save = async (withVersion = version) => {
    setBusy(true);
    setError(null);
    setConflict(null);
    setServerErrors(null);
    const body: StaffInput = {
      name: form.name.trim(),
      nameAr: form.nameAr.trim() || null,
      role: form.role.trim() || null,
      color: form.color,
      userId: form.userId || null,
      schedule: toSchedule(model),
    };
    try {
      let saved: StaffResource;
      if (!resource) {
        saved = await createStaff({ ...body, serviceIds: form.serviceIds });
      } else {
        saved = await updateStaff(resource.id, { ...body, ...(archived ? {} : { active: form.active }), version: withVersion });
        if ([...form.serviceIds].sort().join() !== [...resource.serviceIds].sort().join()) {
          saved = await setStaffServices(resource.id, form.serviceIds);
        }
      }
      onSaved(saved);
    } catch (e) {
      const current = conflictCurrent<StaffResource>(e);
      if (current) setConflict(current);
      else {
        const rows = e instanceof ApiError && errorKey(e) === "bookings.schedule_invalid" ? serverError(e.body) : null;
        if (rows) setServerErrors(rows);
        setError(bookingErrorText(e, tx));
      }
    } finally {
      setBusy(false);
    }
  };

  const memberOptions = members.filter((m) => m.id === form.userId || !takenUserIds.has(m.id));
  const serviceOptions = services.filter((s) => !s.archivedAt || form.serviceIds.includes(s.id));

  return (
    <Modal onClose={onClose} width={640} label={resource ? tx("Edit staff", "تعديل الموظف") : tx("New staff", "موظف جديد")}>
      <form
        dir={lang === "ar" ? "rtl" : "ltr"}
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid && !busy) void save();
        }}
        style={{ display: "grid", gap: 12, maxHeight: "80vh", overflowY: "auto" }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>{resource ? tx("Edit staff", "تعديل الموظف") : tx("New staff", "موظف جديد")}</h3>
        {conflict && (
          <ConflictBanner
            tx={tx}
            onLoadTheirs={() => {
              setForm(formOf(conflict));
              dispatch({ type: "reset", schedule: conflict.schedule });
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
            <span style={LABEL}>{tx("Name", "الاسم")}</span>
            <input style={{ ...FIELD, width: "100%" }} value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} />
          </label>
          <label>
            <span style={LABEL}>{tx("Name (Arabic)", "الاسم (بالعربية)")}</span>
            <input style={{ ...FIELD, width: "100%" }} dir="rtl" value={form.nameAr} maxLength={120} onChange={(e) => set("nameAr", e.target.value)} />
          </label>
          <label>
            <span style={LABEL}>{tx("Role", "المسمى")}</span>
            <input style={{ ...FIELD, width: "100%" }} placeholder={tx("e.g. Stylist", "مثل: مصفف شعر")} value={form.role} maxLength={80} onChange={(e) => set("role", e.target.value)} />
          </label>
          <label>
            <span style={LABEL}>{tx("Workspace member", "عضو مساحة العمل")}</span>
            <select style={{ ...FIELD, width: "100%" }} value={form.userId} onChange={(e) => set("userId", e.target.value)}>
              <option value="">{tx("Not a member (chair, room…)", "ليس عضوًا (كرسي، غرفة…)")}</option>
              {memberOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <span style={LABEL}>{tx("Colour", "اللون")}</span>
          <ColorPicker value={form.color} onChange={(c) => set("color", c)} tx={tx} />
        </div>
        <div>
          <span style={LABEL}>{tx("Services", "الخدمات")}</span>
          {serviceOptions.length === 0 && <div className="muted" style={{ fontSize: 12 }}>{tx("No services yet.", "لا توجد خدمات بعد.")}</div>}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {serviceOptions.map((s) => {
              const on = form.serviceIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  className={`cal-chip ${on ? "active" : ""}`.trim()}
                  onClick={() => set("serviceIds", on ? form.serviceIds.filter((x) => x !== s.id) : [...form.serviceIds, s.id])}
                >
                  <bdi>{lang === "ar" ? s.nameAr : s.name}</bdi>
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <span style={LABEL}>{tx("Working hours", "ساعات العمل")}</span>
          <WeeklyScheduleEditor model={model} dispatch={dispatch} errors={errors} tx={tx} lang={lang} tz={tz} disabled={busy} />
        </div>
        {resource && !archived && (
          <Toggle on={form.active} onChange={(v) => set("active", v)} label={tx("Takes new bookings", "يقبل حجوزات جديدة")} />
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", position: "sticky", bottom: 0, background: "var(--bg-0, var(--bg-1))", paddingBlock: 6 }}>
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
