/** SP-10 service and staff filters for the Schedule tab (hash-backed: `service`, `staff`). */
import type { Tx } from "@/lib/tx";
import type { Lang, Service, StaffResource } from "@/lib/types";
import { FIELD } from "./catalogUi";

const SELECT = { ...FIELD, height: 28, fontSize: 12, maxWidth: 180 };

export function ServiceFilter({ services, value, onChange, tx, lang }: { services: Service[]; value: string | null; onChange: (id: string | null) => void; tx: Tx; lang: Lang }) {
  return (
    <select aria-label={tx("Filter by service", "تصفية حسب الخدمة")} style={SELECT} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{tx("All services", "كل الخدمات")}</option>
      {services.map((s) => (
        <option key={s.id} value={s.id}>
          {lang === "ar" ? s.nameAr : s.name}
          {s.archivedAt ? ` (${tx("archived", "مؤرشفة")})` : ""}
        </option>
      ))}
    </select>
  );
}

export function StaffFilter({ staff, value, onChange, tx, lang }: { staff: StaffResource[]; value: string | null; onChange: (id: string | null) => void; tx: Tx; lang: Lang }) {
  return (
    <select aria-label={tx("Filter by staff", "تصفية حسب الموظف")} style={SELECT} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{tx("All staff", "كل الموظفين")}</option>
      {staff.map((r) => (
        <option key={r.id} value={r.id}>
          {lang === "ar" ? r.nameAr || r.name : r.name}
          {r.archivedAt ? ` (${tx("archived", "مؤرشف")})` : ""}
        </option>
      ))}
    </select>
  );
}
