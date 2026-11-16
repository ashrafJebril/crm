/**
 * SP-10 slot picker: free starts of a service on one workspace-local date
 * (GET /bookings/availability), grouped Morning / Afternoon / Evening, times
 * in the workspace zone in `<bdi>`. With "Any staff" a time shows once and
 * books the first free staff member.
 */
import { useFetch } from "@/api/useFetch";
import type { Tx } from "@/lib/tx";
import type { StaffResource } from "@/lib/types";
import { availabilityPath, type AvailabilityDto } from "./bookingApi";
import { bookingErrorText } from "./bookingErrors";
import { ApiError } from "@/api/client";
import { groupSlots, PART_WORDS, type PartOfDay } from "./slots";

export interface PickedSlot {
  startAt: string;
  resourceId: string;
}

interface Props {
  serviceId: string;
  resourceId: string | null;
  date: string;
  tz: string;
  tx: Tx;
  staffById: Map<string, StaffResource>;
  value: PickedSlot | null;
  onChange: (s: PickedSlot | null) => void;
  /** Bump to refetch (e.g. after SLOT_TAKEN). */
  refreshKey?: number;
  lang: "en" | "ar";
  /** Reschedule: the booking being moved (its own time stays offered) and its duration. */
  excludeAppointmentId?: string;
  durationMin?: number;
}

export function SlotPicker({ serviceId, resourceId, date, tz, tx, staffById, value, onChange, refreshKey, lang, excludeAppointmentId, durationMin }: Props) {
  const q = useFetch<AvailabilityDto>(
    serviceId && date ? availabilityPath({ serviceId, resourceId, date, excludeAppointmentId, durationMin }) : null,
    { key: refreshKey },
  );
  if (q.loading && !q.data) return <div className="muted" style={{ fontSize: 12 }}>{tx("Finding free times…", "جارٍ البحث عن أوقات متاحة…")}</div>;
  if (q.error) {
    return <div style={{ color: "var(--bad)", fontSize: 12 }}>{bookingErrorText(new ApiError(q.error, 400), tx)}</div>;
  }
  const data = q.data;
  if (!data) return null;
  const groups = groupSlots(data.slots, tz);
  const empty = !data.slots.length;
  const nameOf = (id: string) => {
    const r = staffById.get(id);
    return r ? (lang === "ar" ? r.nameAr || r.name : r.name) : "";
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="muted" style={{ fontSize: 11 }}>
        {tx("Times in", "الأوقات بتوقيت")} <bdi>{data.tz}</bdi>
      </div>
      {empty && (
        <div className="muted" style={{ fontSize: 12 }}>
          {data.unconfigured.length
            ? tx("No free times. Some staff have no working hours set.", "لا توجد أوقات متاحة. بعض الموظفين لم تُحدَّد ساعات عملهم.")
            : tx("No free times on this day.", "لا توجد أوقات متاحة في هذا اليوم.")}
        </div>
      )}
      {(Object.keys(groups) as PartOfDay[]).map((part) =>
        groups[part].length ? (
          <div key={part} style={{ display: "grid", gap: 4 }}>
            <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{tx(...PART_WORDS[part])}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {groups[part].map((c) => {
                const picked = value && new Date(value.startAt).getTime() === new Date(c.startAt).getTime();
                const res = picked && value && c.resourceIds.includes(value.resourceId) ? value.resourceId : c.resourceIds[0];
                return (
                  <button
                    key={c.startAt}
                    type="button"
                    aria-pressed={!!picked}
                    className={`cal-chip ${picked ? "active" : ""}`.trim()}
                    title={c.resourceIds.map(nameOf).filter(Boolean).join(", ")}
                    onClick={() => onChange({ startAt: c.startAt, resourceId: res })}
                  >
                    <bdi className="mono">{c.time}</bdi>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null,
      )}
      {data.truncated && <div className="muted" style={{ fontSize: 11 }}>{tx("Showing the first times only.", "تُعرض الأوقات الأولى فقط.")}</div>}
      {value && !resourceId && staffById.get(value.resourceId) && (
        <div style={{ fontSize: 12 }}>
          {tx("With", "مع")} <bdi>{nameOf(value.resourceId)}</bdi>
        </div>
      )}
    </div>
  );
}
