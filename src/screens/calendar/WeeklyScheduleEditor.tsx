/**
 * SP-10 weekly schedule editor: seven rows in the language's week order
 * (Saturday first in Arabic), day on/off, up to 3 time ranges a day,
 * add/remove, copy a day to every open day, and inline errors with the
 * backend's reasons on the exact row. Times are wall clock in the workspace
 * timezone, shown in `<bdi>` with Latin digits.
 */
import type { Lang } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { IconPlus, IconX } from "@/icons";
import { Toggle } from "@/components/Toggle";
import { MAX_WINDOWS_PER_DAY } from "./bookingConstants";
import { scheduleReasonText } from "./bookingErrors";
import { dayName, weekOrder } from "./schedule";
import { WEEKDAYS, type Weekday } from "./bookingTime";
import type { EditorAction, EditorModel } from "./scheduleEditor";
import type { ScheduleError } from "./schedule";

interface Props {
  model: EditorModel;
  dispatch: (a: EditorAction) => void;
  errors: Partial<Record<Weekday, ScheduleError>>;
  tx: Tx;
  lang: Lang;
  tz: string;
  disabled?: boolean;
}

const TIME_INPUT = {
  height: 30,
  padding: "0 6px",
  borderRadius: 6,
  background: "var(--bg-1)",
  border: "1px solid var(--line-soft)",
  color: "var(--ink)",
  fontSize: 13,
  fontFamily: "var(--font-mono)",
  direction: "ltr" as const,
};

export function WeeklyScheduleEditor({ model, dispatch, errors, tx, lang, tz, disabled }: Props) {
  const openDays = WEEKDAYS.filter((d) => model[d].on);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        {tx("Times in", "الأوقات بتوقيت")} <bdi>{tz}</bdi>
      </div>
      {weekOrder(lang).map((day) => {
        const d = model[day];
        const err = errors[day];
        return (
          <div
            key={day}
            data-testid={`schedule-${day}`}
            style={{
              display: "grid",
              gridTemplateColumns: "96px 1fr",
              gap: 8,
              alignItems: "start",
              padding: "6px 8px",
              borderRadius: 8,
              border: `1px solid ${err ? "var(--bad)" : "var(--line-soft)"}`,
              background: d.on ? "var(--bg-1)" : "transparent",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 30 }}>
              <Toggle on={d.on} onChange={() => !disabled && dispatch({ type: "toggle", day })} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>{dayName(day, lang)}</span>
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {!d.on && <div className="muted" style={{ fontSize: 12, minHeight: 30, display: "flex", alignItems: "center" }}>{tx("Day off", "يوم عطلة")}</div>}
              {d.on &&
                d.windows.map((w, i) => {
                  const rowErr = err && (err.index === i || (err.index === null && i === 0));
                  return (
                    <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <bdi>
                        <input
                          aria-label={tx("From", "من")}
                          aria-invalid={rowErr || undefined}
                          style={{ ...TIME_INPUT, borderColor: rowErr ? "var(--bad)" : "var(--line-soft)" }}
                          value={w.from}
                          placeholder="09:00"
                          inputMode="numeric"
                          maxLength={5}
                          disabled={disabled}
                          onChange={(e) => dispatch({ type: "set", day, index: i, field: "from", value: e.target.value })}
                        />
                      </bdi>
                      <span aria-hidden>–</span>
                      <bdi>
                        <input
                          aria-label={tx("To", "إلى")}
                          aria-invalid={rowErr || undefined}
                          style={{ ...TIME_INPUT, borderColor: rowErr ? "var(--bad)" : "var(--line-soft)" }}
                          value={w.to}
                          placeholder="17:00"
                          inputMode="numeric"
                          maxLength={5}
                          disabled={disabled}
                          onChange={(e) => dispatch({ type: "set", day, index: i, field: "to", value: e.target.value })}
                        />
                      </bdi>
                      <button
                        type="button"
                        className="btn ghost icon sm"
                        aria-label={tx("Remove range", "إزالة الفترة")}
                        disabled={disabled}
                        onClick={() => dispatch({ type: "remove", day, index: i })}
                      >
                        <IconX w={12} />
                      </button>
                      {rowErr && (
                        <span role="alert" style={{ color: "var(--bad)", fontSize: 12, flexBasis: "100%" }}>
                          {scheduleReasonText(err!.reason, tx)}
                        </span>
                      )}
                    </div>
                  );
                })}
              {d.on && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={disabled || d.windows.length >= MAX_WINDOWS_PER_DAY}
                    onClick={() => dispatch({ type: "add", day })}
                  >
                    <IconPlus w={12} />
                    {tx("Add range", "إضافة فترة")}
                  </button>
                  {openDays.length > 1 && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={disabled}
                      onClick={() => dispatch({ type: "copy", from: day, to: openDays })}
                    >
                      {tx("Copy to all open days", "نسخ إلى كل أيام العمل")}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div className="muted" style={{ fontSize: 12 }}>
        {tx(
          "No hours on any day means the schedule is not set: bookings are not checked against it and no free slots are offered.",
          "عدم تحديد ساعات لأي يوم يعني أن الجدول غير محدد: لا تُفحص الحجوزات مقابله ولا تُعرض أوقات متاحة.",
        )}
      </div>
    </div>
  );
}
