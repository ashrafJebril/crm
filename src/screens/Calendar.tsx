import {
  memo,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { useRoute } from "@/router";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/Avatar";
import { Badge, type BadgeKind } from "@/components/Badge";
import {
  IconAlert,
  IconArrow,
  IconBolt,
  IconCal,
  IconCheck,
  IconCheckCircle,
  IconChev,
  IconClock,
  IconHand,
  IconMore,
  IconPhone,
  IconPlus,
  IconUsers,
  IconX,
} from "@/icons";
import { useFetch } from "@/api/useFetch";
import type {
  Appointment,
  AppointmentStatus,
  Contact,
  TeamMember,
} from "@/lib/types";
import { usePermissions } from "@/auth/usePermissions";
import { useAuth } from "@/auth/context";
import { ServicesTab } from "./calendar/ServicesTab";
import { StaffTab } from "./calendar/StaffTab";
import { useCatalogParams } from "./calendar/useCatalogParams";
import type { CalendarTab } from "./calendar/catalogParams";
import { workspaceTz, wallClock, addDays as addDaysISO } from "./calendar/bookingTime";
import type { Service, StaffResource } from "@/lib/types";
import { useCalendarParams } from "./calendar/useCalendarParams";
import { appointmentsQuery, viewDays, type CalendarView } from "./calendar/calendarParams";
import { BookingsBoard } from "./calendar/BookingsBoard";
import { AgendaView } from "./calendar/AgendaView";
import { BookingDialog } from "./calendar/BookingDialog";
import { RescheduleDialog } from "./calendar/RescheduleDialog";
import { ServiceFilter, StaffFilter } from "./calendar/ServiceFilter";
import { BookingSearch } from "./calendar/BookingSearch";
import { BookingBadges } from "./calendar/BookingBadges";
import { MOVE_WORDS, allowedFrom, isOpenStatus } from "./calendar/bookingStatus";
import { bookingErrorText } from "./calendar/bookingErrors";
import { updateBooking } from "./calendar/bookingApi";

interface TeamApiMember extends TeamMember {
  status?: "online" | "away" | "offline";
  twoFA?: boolean;
  email?: string;
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Constants                                                                */
/* ─────────────────────────────────────────────────────────────────────── */

type ViewMode = CalendarView;
type FilterId = "all" | "confirmed" | "pending" | "today" | "week";

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
const HOUR_PX = 56;
const TOTAL_HOURS = DAY_END_HOUR - DAY_START_HOUR;

const STATUS_TO_BADGE: Record<AppointmentStatus, BadgeKind> = {
  confirmed: "ok",
  pending: "warn",
  completed: "",
  cancelled: "bad",
  "no-show": "bad",
};

const SOURCE_KIND: Record<Appointment["source"], BadgeKind> = {
  human: "human",
  "self-booking": "info",
};

/* ─────────────────────────────────────────────────────────────────────── */
/* Date helpers                                                             */
/* ─────────────────────────────────────────────────────────────────────── */

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  const day = out.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  out.setDate(out.getDate() + offset);
  out.setHours(0, 0, 0, 0);
  return out;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function fmtTime(d: Date, lang: "en" | "ar"): string {
  return d.toLocaleTimeString(lang === "ar" ? "ar-EG" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtDateShort(d: Date, lang: "en" | "ar"): string {
  return d.toLocaleDateString(lang === "ar" ? "ar-EG" : "en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtDayLabel(d: Date, lang: "en" | "ar"): string {
  return d.toLocaleDateString(lang === "ar" ? "ar-EG" : "en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function fmtRange(start: Date, end: Date, lang: "en" | "ar"): string {
  const a = start.toLocaleDateString(lang === "ar" ? "ar-EG" : "en-US", {
    month: "short",
    day: "numeric",
  });
  const b = end.toLocaleDateString(lang === "ar" ? "ar-EG" : "en-US", {
    month: "short",
    day: "numeric",
  });
  return `${a} – ${b}`;
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Stat tile (local — same shape as Dashboard)                              */
/* ─────────────────────────────────────────────────────────────────────── */

interface MiniStatProps {
  label: string;
  value: string;
  unit?: string;
  sub: string;
  icon: ReactNode;
  tone?: "" | "ok" | "warn" | "bad";
}

function MiniStat({ label, value, unit, sub, icon, tone = "" }: MiniStatProps) {
  const toneColor =
    tone === "ok"
      ? "var(--ok)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "bad"
          ? "var(--bad)"
          : "var(--accent)";
  return (
    <div className="stat">
      <div className="label">
        <span style={{ color: toneColor, display: "inline-flex" }}>{icon}</span>
        {label}
        <span style={{ marginInlineStart: "auto" }}>
          <IconMore w={14} />
        </span>
      </div>
      <div className="value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{sub}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Appointment card (shared by week + day views)                            */
/* ─────────────────────────────────────────────────────────────────────── */

interface ApptCardProps {
  appt: Appointment;
  contactById: Map<string, Contact>;
  tx: Tx;
  lang: "en" | "ar";
  onOpen: (id: string) => void;
  active: boolean;
}

function statusVisual(s: AppointmentStatus): {
  border: string;
  bg: string;
  bar: string;
  fg: string;
  extra?: CSSProperties;
} {
  switch (s) {
    case "confirmed":
      return {
        border: "var(--accent-ring)",
        bg: "var(--accent-soft)",
        bar: "var(--accent)",
        fg: "var(--ink)",
      };
    case "pending":
      return {
        border: "oklch(0.82 0.17 78 / 0.45)",
        bg: "oklch(0.82 0.17 78 / 0.12)",
        bar: "var(--warn)",
        fg: "var(--ink)",
      };
    case "completed":
      return {
        border: "var(--line-soft)",
        bg: "var(--bg-2)",
        bar: "var(--ink-3)",
        fg: "var(--ink-2)",
        extra: { opacity: 0.85 },
      };
    case "cancelled":
      return {
        border: "oklch(0.7 0.22 24 / 0.45)",
        bg: "oklch(0.7 0.22 24 / 0.10)",
        bar: "var(--bad)",
        fg: "var(--ink-2)",
        extra: { opacity: 0.55, textDecoration: "line-through" },
      };
    case "no-show":
      return {
        border: "var(--bad)",
        bg: "oklch(0.7 0.22 24 / 0.08)",
        bar: "var(--bad)",
        fg: "var(--ink)",
        extra: { borderStyle: "dashed" },
      };
  }
}

function ApptCard({ appt, contactById, lang, onOpen, active }: ApptCardProps) {
  const v = statusVisual(appt.status);
  const contact = contactById.get(appt.contactId);
  const start = new Date(appt.startAt);
  const minutesFromTop =
    (start.getHours() - DAY_START_HOUR) * 60 + start.getMinutes();
  const top = Math.max(0, (minutesFromTop / 60) * HOUR_PX);
  const height = Math.max(28, (appt.durationMin / 60) * HOUR_PX - 4);
  const service = lang === "ar" ? appt.serviceAr : appt.service;

  return (
    <button
      type="button"
      onClick={() => onOpen(appt.id)}
      className={`appt-card ${active ? "active" : ""}`.trim()}
      style={{
        position: "absolute",
        insetInlineStart: 4,
        insetInlineEnd: 4,
        top,
        height,
        background: v.bg,
        border: `1px solid ${v.border}`,
        borderInlineStart: `3px solid ${appt.conflict ? "var(--bad)" : v.bar}`,
        outline: appt.fit === "outside_hours" || appt.fit === "off_day" ? "1px dashed var(--warn)" : undefined,
        borderRadius: 8,
        padding: "6px 8px",
        textAlign: "start",
        cursor: "pointer",
        color: v.fg,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        overflow: "hidden",
        ...v.extra,
      }}
      title={`${service} — ${contact?.name ?? ""}`}
    >
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--ink-3)",
          letterSpacing: 0.02,
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <IconClock w={10} />
        {fmtTime(start, lang)}
        <span style={{ marginInlineStart: "auto" }}>{appt.durationMin}m</span>
      </div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          lineHeight: 1.25,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {service}
      </div>
      {height > 44 && contact && (
        <div
          style={{
            fontSize: 11,
            color: "var(--ink-2)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {contact.name}
        </div>
      )}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Week view                                                                */
/* ─────────────────────────────────────────────────────────────────────── */

interface WeekViewProps {
  weekStart: Date;
  appts: Appointment[];
  contactById: Map<string, Contact>;
  tx: Tx;
  lang: "en" | "ar";
  onOpen: (id: string) => void;
  activeId: string | null;
}

function WeekView({
  weekStart,
  appts,
  contactById,
  tx,
  lang,
  onOpen,
  activeId,
}: WeekViewProps) {
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const today = startOfDay(new Date());
  const apptsByDay = useMemo(() => {
    const map = new Map<number, Appointment[]>();
    for (let i = 0; i < 7; i++) map.set(i, []);
    for (const a of appts) {
      const d = new Date(a.startAt);
      for (let i = 0; i < 7; i++) {
        if (sameDay(d, days[i]!)) {
          map.get(i)!.push(a);
          break;
        }
      }
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
      );
    }
    return map;
  }, [appts, days]);

  const hours = useMemo(
    () =>
      Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => DAY_START_HOUR + i),
    [],
  );

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "60px repeat(7, 1fr)",
          borderBottom: "1px solid var(--line-soft)",
          background: "var(--bg-1)",
        }}
      >
        <div />
        {days.map((d) => {
          const isToday = sameDay(d, today);
          return (
            <div
              key={d.toISOString()}
              style={{
                padding: "10px 12px",
                borderInlineStart: "1px solid var(--line-soft)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: 0.08,
                  color: isToday ? "var(--accent)" : "var(--ink-3)",
                }}
              >
                {d.toLocaleDateString(lang === "ar" ? "ar-EG" : "en-US", {
                  weekday: "short",
                })}
              </div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: isToday ? "var(--accent)" : "var(--ink)",
                  letterSpacing: "-0.01em",
                }}
              >
                {d.getDate()}
                {isToday && (
                  <span
                    style={{
                      marginInlineStart: 8,
                      fontSize: 10,
                      fontFamily: "var(--font-mono)",
                      color: "var(--accent)",
                      verticalAlign: "middle",
                    }}
                  >
                    {tx("today", "اليوم")}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: "60px repeat(7, 1fr)",
          maxHeight: HOUR_PX * TOTAL_HOURS + 20,
          overflowY: "auto",
        }}
      >
        {/* Hour gutter */}
        <div style={{ position: "relative" }}>
          {hours.map((h, i) => (
            <div
              key={h}
              className="mono"
              style={{
                position: "absolute",
                top: i * HOUR_PX - 6,
                insetInlineEnd: 8,
                fontSize: 10,
                color: "var(--ink-3)",
              }}
            >
              {String(h).padStart(2, "0")}:00
            </div>
          ))}
          <div style={{ height: HOUR_PX * TOTAL_HOURS }} />
        </div>

        {/* 7 day columns */}
        {days.map((d, idx) => {
          const dayAppts = apptsByDay.get(idx) ?? [];
          return (
            <div
              key={d.toISOString()}
              style={{
                position: "relative",
                borderInlineStart: "1px solid var(--line-soft)",
              }}
            >
              {hours.map((_, hi) => (
                <div
                  key={hi}
                  style={{
                    height: HOUR_PX,
                    borderBottom: "1px solid var(--line-soft)",
                  }}
                />
              ))}
              {dayAppts.map((a) => (
                <ApptCard
                  key={a.id}
                  appt={a}
                  contactById={contactById}
                  tx={tx}
                  lang={lang}
                  onOpen={onOpen}
                  active={activeId === a.id}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Day view                                                                 */
/* ─────────────────────────────────────────────────────────────────────── */

interface DayViewProps {
  day: Date;
  appts: Appointment[];
  contactById: Map<string, Contact>;
  tx: Tx;
  lang: "en" | "ar";
  onOpen: (id: string) => void;
  activeId: string | null;
  onPickDay: (d: Date) => void;
  weekStart: Date;
}

function DayView({
  day,
  appts,
  contactById,
  tx,
  lang,
  onOpen,
  activeId,
  onPickDay,
  weekStart,
}: DayViewProps) {
  const dayAppts = useMemo(
    () =>
      appts
        .filter((a) => sameDay(new Date(a.startAt), day))
        .sort(
          (a, b) =>
            new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
        ),
    [appts, day],
  );
  const hours = useMemo(
    () =>
      Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => DAY_START_HOUR + i),
    [],
  );
  const today = startOfDay(new Date());

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--line-soft)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div
          style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}
        >
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: "var(--ink-3)",
              textTransform: "uppercase",
              letterSpacing: 0.08,
            }}
          >
            {sameDay(day, today)
              ? tx("Today", "اليوم")
              : tx("Selected day", "اليوم المحدد")}
          </div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            {fmtDayLabel(day, lang)}
          </div>
        </div>
        <div className="mono" style={{ color: "var(--ink-3)", fontSize: 12 }}>
          {dayAppts.length}{" "}
          {tx("appointments", "موعد")}
        </div>
      </div>

      <div
        style={{
          padding: "8px 14px",
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          borderBottom: "1px solid var(--line-soft)",
          background: "var(--bg-1)",
        }}
      >
        {Array.from({ length: 7 }, (_, i) => {
          const d = addDays(weekStart, i);
          const isActive = sameDay(d, day);
          const isToday = sameDay(d, today);
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onPickDay(d)}
              className={`day-pill ${isActive ? "active" : ""}`.trim()}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                padding: "6px 10px",
                borderRadius: 10,
                background: isActive
                  ? "var(--accent-soft)"
                  : "var(--bg-2)",
                border: `1px solid ${
                  isActive ? "var(--accent-ring)" : "var(--line-soft)"
                }`,
                cursor: "pointer",
                color: isActive ? "var(--accent)" : "var(--ink-1)",
                minWidth: 52,
              }}
            >
              <span
                className="mono"
                style={{ fontSize: 10, color: isToday ? "var(--accent)" : "var(--ink-3)" }}
              >
                {d.toLocaleDateString(lang === "ar" ? "ar-EG" : "en-US", {
                  weekday: "short",
                })}
              </span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                {d.getDate()}
              </span>
            </button>
          );
        })}
      </div>

      <div
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: "70px 1fr",
          maxHeight: HOUR_PX * TOTAL_HOURS + 20,
          overflowY: "auto",
        }}
      >
        <div style={{ position: "relative" }}>
          {hours.map((h, i) => (
            <div
              key={h}
              className="mono"
              style={{
                position: "absolute",
                top: i * HOUR_PX - 6,
                insetInlineEnd: 8,
                fontSize: 11,
                color: "var(--ink-3)",
              }}
            >
              {String(h).padStart(2, "0")}:00
            </div>
          ))}
          <div style={{ height: HOUR_PX * TOTAL_HOURS }} />
        </div>
        <div
          style={{
            position: "relative",
            borderInlineStart: "1px solid var(--line-soft)",
          }}
        >
          {hours.map((_, hi) => (
            <div
              key={hi}
              style={{
                height: HOUR_PX,
                borderBottom: "1px solid var(--line-soft)",
              }}
            />
          ))}
          {dayAppts.length === 0 && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                color: "var(--ink-3)",
                fontSize: 13,
              }}
            >
              <div style={{ textAlign: "center" }}>
                <IconCal w={28} />
                <div style={{ marginTop: 8 }}>
                  {tx("No appointments this day", "لا توجد مواعيد")}
                </div>
              </div>
            </div>
          )}
          {dayAppts.map((a) => (
            <ApptCard
              key={a.id}
              appt={a}
              contactById={contactById}
              tx={tx}
              lang={lang}
              onOpen={onOpen}
              active={activeId === a.id}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* List view                                                                */
/* ─────────────────────────────────────────────────────────────────────── */

interface ListViewProps {
  appts: Appointment[];
  contactById: Map<string, Contact>;
  team: TeamApiMember[];
  tx: Tx;
  lang: "en" | "ar";
  onOpen: (id: string) => void;
  activeId: string | null;
}

function ListView({
  appts,
  contactById,
  team,
  tx,
  lang,
  onOpen,
  activeId,
}: ListViewProps) {
  const now = new Date();
  const groups = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    const sorted = [...appts].sort(
      (a, b) =>
        new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
    );
    for (const a of sorted) {
      const d = startOfDay(new Date(a.startAt));
      const key = d.toISOString();
      const list = map.get(key) ?? [];
      list.push(a);
      map.set(key, list);
    }
    return Array.from(map.entries()).map(([key, list]) => ({
      key,
      day: new Date(key),
      list,
    }));
  }, [appts]);

  if (groups.length === 0) {
    return (
      <div className="card empty">
        <IconCal w={36} />
        <div style={{ marginTop: 8 }}>
          {tx("No appointments match", "لا توجد مواعيد مطابقة")}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {groups.map(({ key, day, list }) => {
        const isPast = day.getTime() < startOfDay(now).getTime();
        return (
          <div key={key} className="card" style={{ overflow: "hidden" }}>
            <div
              className="card-h"
              style={{
                opacity: isPast ? 0.7 : 1,
              }}
            >
              <div>
                <h3>{fmtDayLabel(day, lang)}</h3>
                <div className="sub">
                  {list.length}{" "}
                  {tx("appointments", "موعد")}
                  {isPast && (
                    <>
                      {" · "}
                      <span className="muted">{tx("past", "ماضي")}</span>
                    </>
                  )}
                </div>
              </div>
              {sameDay(day, now) && (
                <Badge kind="accent" dot>
                  {tx("today", "اليوم")}
                </Badge>
              )}
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 110 }}>{tx("Time", "الوقت")}</th>
                  <th>{tx("Contact", "العميل")}</th>
                  <th>{tx("Service", "الخدمة")}</th>
                  <th style={{ width: 160 }}>
                    {tx("Agent / Staff", "الوكيل / الموظف")}
                  </th>
                  <th style={{ width: 120 }}>{tx("Status", "الحالة")}</th>
                  <th style={{ width: 110 }}>{tx("Source", "المصدر")}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => {
                  const start = new Date(a.startAt);
                  const contact = contactById.get(a.contactId);
                  const staff = a.staffId
                    ? team.find((m) => m.id === a.staffId)
                    : undefined;
                  const service = lang === "ar" ? a.serviceAr : a.service;
                  const isCancelled = a.status === "cancelled";
                  return (
                    <tr
                      key={a.id}
                      className={activeId === a.id ? "selected" : ""}
                      style={{
                        cursor: "pointer",
                        opacity: isPast ? 0.7 : 1,
                      }}
                      onClick={() => onOpen(a.id)}
                    >
                      <td>
                        <div
                          className="mono"
                          style={{ fontSize: 12, color: "var(--ink-1)" }}
                        >
                          {fmtTime(start, lang)}
                        </div>
                        <div
                          className="mono"
                          style={{ fontSize: 10, color: "var(--ink-3)" }}
                        >
                          {a.durationMin} min
                        </div>
                      </td>
                      <td>
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          <Avatar
                            name={contact?.name}
                            color="200"
                            size="sm"
                          />
                          <div>
                            <div style={{ fontWeight: 500, fontSize: 13 }}>
                              {contact?.name ?? "—"}
                            </div>
                            <div
                              className="mono"
                              style={{ fontSize: 11, color: "var(--ink-3)" }}
                            >
                              {contact?.phone}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td
                        style={{
                          textDecoration: isCancelled
                            ? "line-through"
                            : "none",
                        }}
                      >
                        {service}
                      </td>
                      <td>
                        <div
                          style={{
                            display: "flex",
                            gap: 6,
                            alignItems: "center",
                          }}
                        >
                          {staff ? (
                            <>
                              <Avatar
                                name={staff.name}
                                color={staff.color}
                                size="sm"
                              />
                              <span style={{ fontSize: 12 }}>{staff.name}</span>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <Badge kind={STATUS_TO_BADGE[a.status]} dot>
                          {statusLabel(a.status, tx)}
                        </Badge>
                      </td>
                      <td>
                        <Badge kind={SOURCE_KIND[a.source]}>
                          {sourceLabel(a.source, tx)}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function statusLabel(s: AppointmentStatus, tx: Tx): string {
  switch (s) {
    case "confirmed":
      return tx("Confirmed", "مؤكد");
    case "pending":
      return tx("Pending", "بانتظار");
    case "completed":
      return tx("Completed", "مكتمل");
    case "cancelled":
      return tx("Cancelled", "ملغي");
    case "no-show":
      return tx("No-show", "لم يحضر");
  }
}

function sourceLabel(s: Appointment["source"], tx: Tx): string {
  switch (s) {
    case "human":
      return tx("Human", "بشري");
    case "self-booking":
      return tx("Self-book", "حجز ذاتي");
  }
}

/* ─────────────────────────────────────────────────────────────────────── */
/* New-appointment modal                                                    */
/* ─────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────── */
/* Side panel                                                               */
/* ─────────────────────────────────────────────────────────────────────── */

interface SidePanelProps {
  appt: Appointment;
  contactById: Map<string, Contact>;
  team: TeamApiMember[];
  tx: Tx;
  lang: "en" | "ar";
  onClose: () => void;
  onOpenConversation: () => void;
  onChangeStatus: (status: AppointmentStatus) => Promise<void>;
  statusUpdating: boolean;
  statusError: string | null;
  canUpdate: boolean;
  onReschedule: () => void;
}

function SidePanel({
  appt,
  contactById,
  team,
  tx,
  lang,
  onClose,
  onOpenConversation,
  onChangeStatus,
  statusUpdating,
  statusError,
  canUpdate,
  onReschedule,
}: SidePanelProps) {
  const start = new Date(appt.startAt);
  const end = new Date(start.getTime() + appt.durationMin * 60_000);
  const contact = contactById.get(appt.contactId);
  const staff = appt.staffId
    ? team.find((m) => m.id === appt.staffId)
    : undefined;
  const service = lang === "ar" ? appt.serviceAr : appt.service;
  const note = lang === "ar" ? appt.noteAr ?? appt.note : appt.note;

  return (
    <aside
      style={{
        position: "fixed",
        top: 56,
        bottom: 0,
        insetInlineEnd: 0,
        width: 380,
        background: "var(--bg-1)",
        borderInlineStart: "1px solid var(--line-soft)",
        boxShadow: "var(--shadow-lg)",
        display: "flex",
        flexDirection: "column",
        zIndex: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "14px 16px",
          borderBottom: "1px solid var(--line-soft)",
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 0.08,
            color: "var(--ink-3)",
            flex: 1,
          }}
        >
          {tx("Appointment", "موعد")} · #{appt.id}
        </div>
        <button
          className="btn ghost icon sm"
          onClick={onClose}
          aria-label={tx("Close", "إغلاق")}
        >
          <IconX w={14} />
        </button>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: "-0.01em",
            }}
          >
            {service}
          </h2>
          <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Badge kind={STATUS_TO_BADGE[appt.status]} dot>
              {statusLabel(appt.status, tx)}
            </Badge>
            <Badge kind={SOURCE_KIND[appt.source]}>
              {sourceLabel(appt.source, tx)}
            </Badge>
            <BookingBadges appt={appt} tx={tx} />
            {appt.reminderSent && (
              <Badge kind="ok">
                <IconCheck w={10} />
                {tx("Reminder sent", "تم تذكير")}
              </Badge>
            )}
            {appt.hjzSyncError ? (
              <span title={appt.hjzSyncError}>
                <Badge kind="warn">{tx("Not in HJZ", "غير موجود في HJZ")}</Badge>
              </span>
            ) : appt.hjzSyncPending ? (
              <Badge kind="info">{tx("Syncing to HJZ", "جارٍ المزامنة مع HJZ")}</Badge>
            ) : appt.hjzAppointmentId ? (
              <Badge kind="ok">
                <IconCheck w={10} />
                {tx("In HJZ", "في HJZ")}
              </Badge>
            ) : null}
          </div>
          {appt.hjzSyncError && (
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--ink-3)" }}>
              {tx("HJZ didn't accept this booking: ", "لم يقبل HJZ هذا الحجز: ")}
              <span className="mono">{appt.hjzSyncError}</span>
            </div>
          )}
        </div>

        <div
          style={{
            border: "1px solid var(--line-soft)",
            borderRadius: 10,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ color: "var(--accent)" }}>
              <IconCal w={16} />
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {fmtDayLabel(start, lang)}
              </div>
              <div
                className="mono"
                style={{ fontSize: 11, color: "var(--ink-3)" }}
              >
                {fmtTime(start, lang)} – {fmtTime(end, lang)} · {appt.durationMin}{" "}
                {tx("min", "د")}
              </div>
            </div>
          </div>
        </div>

        {contact && (
          <div>
            <SectionLabel>{tx("Contact", "العميل")}</SectionLabel>
            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: 10,
                borderRadius: 10,
                border: "1px solid var(--line-soft)",
              }}
            >
              <Avatar name={contact.name} color="200" size="lg" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{contact.name}</div>
                <div
                  className="mono"
                  style={{ fontSize: 11, color: "var(--ink-3)" }}
                >
                  {contact.phone}
                </div>
              </div>
              <button className="btn ghost icon sm" title={tx("Call", "اتصال")}>
                <IconPhone w={14} />
              </button>
            </div>
          </div>
        )}

        {staff && (
          <div>
            <SectionLabel>{tx("Owners", "المسؤولون")}</SectionLabel>
            <div
              style={{
                marginTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {staff && (
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    padding: 10,
                    borderRadius: 10,
                    border: "1px solid var(--line-soft)",
                  }}
                >
                  <Avatar
                    name={staff.name}
                    color={staff.color}
                    size="lg"
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500 }}>{staff.name}</div>
                    <div
                      className="mono"
                      style={{ fontSize: 11, color: "var(--ink-3)" }}
                    >
                      {staff.role}
                    </div>
                  </div>
                  <Badge kind="human">
                    <IconHand w={10} />
                    {tx("Staff", "موظف")}
                  </Badge>
                </div>
              )}
            </div>
          </div>
        )}

        {note && (
          <div>
            <SectionLabel>{tx("Notes", "ملاحظات")}</SectionLabel>
            <div
              style={{
                marginTop: 8,
                padding: 10,
                borderRadius: 10,
                background: "var(--bg-2)",
                border: "1px solid var(--line-soft)",
                fontSize: 13,
                color: "var(--ink-1)",
              }}
            >
              {note}
            </div>
          </div>
        )}

        <div>
          <SectionLabel>{tx("Activity", "النشاط")}</SectionLabel>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: "8px 0 0",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <li
              style={{
                display: "flex",
                gap: 8,
                fontSize: 12,
                alignItems: "center",
              }}
            >
              <IconCheckCircle w={12} />
              <span style={{ color: "var(--ink-1)", flex: 1 }}>
                {tx("Booking confirmed", "تم تأكيد الحجز")}
              </span>
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {fmtDateShort(start, lang)}
              </span>
            </li>
            {appt.reminderSent && (
              <li
                style={{
                  display: "flex",
                  gap: 8,
                  fontSize: 12,
                  alignItems: "center",
                }}
              >
                <IconBolt w={12} />
                <span style={{ color: "var(--ink-1)", flex: 1 }}>
                  {tx("Reminder sent via WhatsApp", "تم إرسال تذكير عبر واتساب")}
                </span>
                <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                  −24h
                </span>
              </li>
            )}
            {appt.status === "no-show" && (
              <li
                style={{
                  display: "flex",
                  gap: 8,
                  fontSize: 12,
                  alignItems: "center",
                }}
              >
                <IconAlert w={12} />
                <span style={{ color: "var(--bad)", flex: 1 }}>
                  {tx("Marked no-show", "حدد كعدم حضور")}
                </span>
              </li>
            )}
          </ul>
        </div>

        <div>
          <SectionLabel>{tx("Actions", "إجراءات")}</SectionLabel>
          <div
            style={{
              marginTop: 8,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            {canUpdate &&
              allowedFrom(appt.status).map((to) => (
                <button
                  key={to}
                  className="btn"
                  onClick={() => {
                    onChangeStatus(to).catch(() => {
                      // surfaced via statusError
                    });
                  }}
                  disabled={statusUpdating}
                >
                  {to === "completed" ? <IconCheckCircle w={13} /> : to === "cancelled" ? <IconX w={13} /> : null}
                  {tx(...MOVE_WORDS[to])}
                </button>
              ))}
            {canUpdate && isOpenStatus(appt.status) && (
              <button className="btn" onClick={onReschedule} disabled={statusUpdating}>
                <IconClock w={13} />
                {tx("Reschedule", "إعادة الجدولة")}
              </button>
            )}
            {(!canUpdate || !allowedFrom(appt.status).length) && (
              <div className="muted" style={{ fontSize: 12, gridColumn: "1 / -1" }}>
                {canUpdate
                  ? tx("This booking is closed.", "هذا الحجز مغلق.")
                  : tx("You can view this booking.", "يمكنك عرض هذا الحجز.")}
              </div>
            )}
          </div>
          {statusError && (
            <div
              role="alert"
              style={{
                marginTop: 8,
                fontSize: 12,
                color: "var(--bad)",
              }}
            >
              {statusError}
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          padding: 14,
          borderTop: "1px solid var(--line-soft)",
          display: "flex",
          gap: 8,
        }}
      >
        <button
          className="btn primary"
          style={{ flex: 1 }}
          onClick={onOpenConversation}
        >
          <IconArrow w={13} />
          {tx("Open conversation", "فتح المحادثة")}
        </button>
        <button className="btn ghost icon" title={tx("More", "المزيد")}>
          <IconMore w={16} />
        </button>
      </div>
    </aside>
  );
}

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      fontSize: 10,
      fontFamily: "var(--font-mono)",
      textTransform: "uppercase",
      letterSpacing: 0.08,
      color: "var(--ink-3)",
    }}
  >
    {children}
  </div>
);

/* ─────────────────────────────────────────────────────────────────────── */
/* Main screen                                                              */
/* ─────────────────────────────────────────────────────────────────────── */

function CalendarImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [, setRoute] = useRoute();

  const { can } = usePermissions();
  const { activeWorkspace } = useAuth();
  const tz = workspaceTz(activeWorkspace?.timezone);
  const today = wallClock(new Date(), tz).dateISO;
  // SP-10: view, date and filters live in the hash (reload and Back restore them).
  const [cal, setCal] = useCalendarParams(today);
  const view: ViewMode = cal.view;
  const setView = (v: ViewMode) => setCal({ view: v });
  const canView = can("bookings.view");
  const canCreate = can("bookings.create");
  const canUpdate = can("bookings.update");
  const [filter, setFilter] = useState<FilterId>("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState<boolean>(false);
  const [rescheduling, setRescheduling] = useState<Appointment | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  // The browser-zone grid views keep their own week; it follows the hash date.
  const selectedDay = useMemo(() => {
    const [y, m, d] = cal.date.split("-").map(Number);
    return new Date(y, m - 1, d);
  }, [cal.date]);
  const weekStart = useMemo(() => startOfWeek(selectedDay), [selectedDay]);
  const setSelectedDay = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    setCal({ date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` });
  };

  // ─── Data ──────────────────────────────────────────────────────────────
  // A bounded range (≤ 92 days) with the service/staff filters, not the whole history.
  const apptsQ = useFetch<Appointment[]>(canView ? appointmentsQuery(cal, tz, t.lang) : null);
  const servicesQ = useFetch<{ items: Service[] }>(canView ? "/services" : null);
  const staffQ = useFetch<{ items: StaffResource[] }>(canView ? "/staff" : null);
  const services = useMemo(() => servicesQ.data?.items ?? [], [servicesQ.data]);
  const staffList = useMemo(() => staffQ.data?.items ?? [], [staffQ.data]);
  const serviceById = useMemo(() => new Map(services.map((x) => [x.id, x])), [services]);
  const staffById = useMemo(() => new Map(staffList.map((x) => [x.id, x])), [staffList]);
  const contactsQ = useFetch<Contact[]>("/contacts");
  const teamQ = useFetch<TeamApiMember[]>("/team");

  const appointments: Appointment[] = useMemo(
    () => apptsQ.data ?? [],
    [apptsQ.data],
  );
  const contacts: Contact[] = useMemo(
    () => contactsQ.data ?? [],
    [contactsQ.data],
  );
  const team: TeamApiMember[] = useMemo(() => teamQ.data ?? [], [teamQ.data]);

  const contactById = useMemo(() => {
    const map = new Map<string, Contact>();
    for (const c of contacts) map.set(c.id, c);
    return map;
  }, [contacts]);

  // ─── Mutations ────────────────────────────────────────────────────────
  // Status moves follow the transition table and send the version the user
  // saw; every refusal is shown as copy, never a raw key (review M2), and
  // the list reloads so the panel shows the current row.
  const handleStatusChange = async (status: AppointmentStatus): Promise<void> => {
    const appt = appointments.find((a) => a.id === activeId);
    if (!appt) return;
    setStatusBusy(true);
    setStatusError(null);
    try {
      await updateBooking(appt.id, { status, version: appt.version ?? 0 });
    } catch (e) {
      setStatusError(bookingErrorText(e, tx));
    } finally {
      setStatusBusy(false);
      void apptsQ.refetch();
    }
  };

  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);

  const stats = useMemo(() => {
    const today = startOfDay(new Date());
    const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    let todayCount = 0;
    let weekCount = 0;
    let completed = 0;
    let noShow = 0;
    for (const a of appointments) {
      const d = new Date(a.startAt);
      if (sameDay(d, today)) todayCount++;
      if (weekDays.some((wd) => sameDay(wd, d))) weekCount++;
      if (a.status === "completed") completed++;
      if (a.status === "no-show") noShow++;
    }
    const finished = completed + noShow || 1;
    const noShowPct = Math.round((noShow / finished) * 100);
    return { todayCount, weekCount, noShowPct };
  }, [weekStart, appointments]);

  const filtered = useMemo(() => {
    const today = startOfDay(new Date());
    const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    return appointments.filter((a) => {
      const d = new Date(a.startAt);
      switch (filter) {
        case "confirmed":
          return a.status === "confirmed";
        case "pending":
          return a.status === "pending";
        case "today":
          return sameDay(d, today);
        case "week":
          return weekDays.some((wd) => sameDay(wd, d));
        case "all":
        default:
          return true;
      }
    });
  }, [filter, weekStart, appointments]);

  const visibleForView = useMemo(() => {
    if (view === "list") return filtered;
    const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    if (view === "week") {
      return filtered.filter((a) =>
        weekDays.some((wd) => sameDay(wd, new Date(a.startAt))),
      );
    }
    return filtered.filter((a) =>
      sameDay(new Date(a.startAt), selectedDay),
    );
  }, [filtered, view, weekStart, selectedDay]);

  const activeAppt = useMemo(
    () => appointments.find((a) => a.id === activeId) ?? null,
    [activeId, appointments],
  );

  // If the active appointment disappeared from the list (e.g. after a refetch
  // following a delete), close the side panel.
  useEffect(() => {
    if (activeId && !activeAppt && !apptsQ.loading) {
      setActiveId(null);
    }
  }, [activeAppt, activeId, apptsQ.loading]);

  const filters: Array<{ id: FilterId; label: string }> = [
    { id: "all", label: tx("All", "الكل") },
    { id: "confirmed", label: tx("Confirmed", "مؤكد") },
    { id: "pending", label: tx("Pending", "بانتظار") },
    { id: "today", label: tx("Today", "اليوم") },
    { id: "week", label: tx("This week", "هذا الأسبوع") },
  ];

  const tabs: Array<{ id: ViewMode; label: string; icon: ReactNode }> = [
    { id: "week", label: tx("Week", "أسبوع"), icon: <IconCal w={14} /> },
    { id: "list", label: tx("List", "قائمة"), icon: <IconUsers w={14} /> },
    { id: "day", label: tx("Day", "يوم"), icon: <IconClock w={14} /> },
    { id: "agenda", label: tx("Agenda", "الأجندة"), icon: <IconCal w={14} /> },
    { id: "board", label: tx("Board", "اللوحة"), icon: <IconUsers w={14} /> },
  ];

  return (
    <div style={{ overflowY: "auto", flex: 1, position: "relative" }}>
      <PageHeader
        title={
          <span>
            {tx("Calendar", "التقويم")}
            <span
              className="display"
              style={{
                fontSize: 18,
                color: "var(--ink-3)",
                marginInlineStart: 12,
                fontWeight: 400,
              }}
            >
              {stats.weekCount}{" "}
              {tx("appointments this week", "موعد هذا الأسبوع")}
            </span>
          </span>
        }
        subtitle={tx(
          "Bookings, reschedules, and no-shows across your team.",
          "الحجوزات والتعديلات وعدم الحضور عبر فريقك.",
        )}
        actions={
          <>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                background: "var(--bg-1)",
                border: "1px solid var(--line-soft)",
                borderRadius: 8,
                padding: 2,
              }}
            >
              <button
                className="btn ghost icon sm"
                onClick={() => setCal({ date: addDaysISO(cal.date, view === "day" ? -1 : -7) })}
                aria-label={tx("Previous week", "الأسبوع السابق")}
                style={{ transform: t.lang === "ar" ? "scaleX(-1)" : undefined }}
              >
                <IconChev w={14} style={{ transform: "scaleX(-1)" }} />
              </button>
              <div
                className="mono"
                style={{
                  padding: "0 10px",
                  fontSize: 12,
                  color: "var(--ink-1)",
                  whiteSpace: "nowrap",
                }}
              >
                {fmtRange(weekStart, weekEnd, t.lang)}
              </div>
              <button
                className="btn ghost icon sm"
                onClick={() => setCal({ date: addDaysISO(cal.date, view === "day" ? 1 : 7) })}
                aria-label={tx("Next week", "الأسبوع التالي")}
                style={{ transform: t.lang === "ar" ? "scaleX(-1)" : undefined }}
              >
                <IconChev w={14} />
              </button>
            </div>
            <button
              className="btn"
              onClick={() => setCal({ date: today })}
            >
              {tx("Today", "اليوم")}
            </button>
            {canView && <BookingSearch tx={tx} lang={t.lang} tz={tz} />}
            <button className="btn primary" disabled={!canCreate} onClick={() => setShowNew(true)}>
              <IconPlus w={14} />
              {tx("New appointment", "موعد جديد")}
            </button>
          </>
        }
      />

      <div style={{ padding: "0 24px 24px", display: "grid", gap: 16 }}>
        {/* Loading / error banner */}
        {apptsQ.loading && appointments.length === 0 && (
          <div
            className="mono"
            style={{
              padding: "8px 12px",
              fontSize: 12,
              color: "var(--ink-3)",
              opacity: 0.7,
            }}
          >
            {tx("loading…", "جارٍ التحميل…")}
          </div>
        )}
        {apptsQ.error && (
          <div
            style={{
              padding: "8px 12px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--bad)",
              border: "1px solid var(--bad)",
              borderRadius: 8,
              background: "oklch(0.7 0.22 24 / 0.08)",
            }}
          >
            <span style={{ flex: 1 }}>{apptsQ.error}</span>
            <button className="btn sm ghost" onClick={apptsQ.refetch}>
              {tx("Retry", "إعادة")}
            </button>
          </div>
        )}

        {/* Stats */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
          }}
        >
          <MiniStat
            label={tx("Today", "اليوم")}
            value={String(stats.todayCount)}
            sub={tx("Scheduled today", "محجوز اليوم")}
            icon={<IconClock w={12} />}
          />
          <MiniStat
            label={tx("This week", "هذا الأسبوع")}
            value={String(stats.weekCount)}
            sub={fmtRange(weekStart, weekEnd, t.lang)}
            icon={<IconCal w={12} />}
          />
          <MiniStat
            label={tx("No-show rate", "نسبة عدم الحضور")}
            value={String(stats.noShowPct)}
            unit="%"
            sub={tx("Last 7 days", "آخر ٧ أيام")}
            icon={<IconAlert w={12} />}
            tone={stats.noShowPct > 15 ? "bad" : "warn"}
          />
        </div>

        {/* Tab + filter row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div className="tabs" style={{ padding: 0, border: 0 }}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={`tab ${view === tab.id ? "active" : ""}`.trim()}
                onClick={() => setView(tab.id)}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          {canView && (
            <>
              <ServiceFilter services={services} value={cal.service} onChange={(id) => setCal({ service: id })} tx={tx} lang={t.lang} />
              <StaffFilter staff={staffList} value={cal.staff} onChange={(id) => setCal({ staff: id })} tx={tx} lang={t.lang} />
            </>
          )}
          <div
            style={{
              display: "flex",
              gap: 4,
              flexWrap: "wrap",
            }}
          >
            {filters.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`cal-chip ${filter === f.id ? "active" : ""}`.trim()}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Active view */}
        {view === "week" && (
          <WeekView
            weekStart={weekStart}
            appts={visibleForView}
            contactById={contactById}
            tx={tx}
            lang={t.lang}
            onOpen={setActiveId}
            activeId={activeId}
          />
        )}
        {view === "list" && (
          <ListView
            appts={visibleForView}
            contactById={contactById}
            team={team}
            tx={tx}
            lang={t.lang}
            onOpen={setActiveId}
            activeId={activeId}
          />
        )}
        {view === "agenda" && (
          <AgendaView
            appts={filtered}
            days={viewDays("agenda", cal.date, t.lang)}
            contactById={contactById}
            staffById={staffById}
            team={team}
            tz={tz}
            tx={tx}
            lang={t.lang}
            onOpen={setActiveId}
          />
        )}
        {view === "board" && (
          <BookingsBoard
            appts={filtered.filter((a) => viewDays("board", cal.date, t.lang).includes(wallClock(new Date(a.startAt), tz).dateISO))}
            contactById={contactById}
            serviceById={serviceById}
            staffById={staffById}
            tz={tz}
            tx={tx}
            lang={t.lang}
            canUpdate={canUpdate}
            onOpen={setActiveId}
            onChanged={() => void apptsQ.refetch()}
          />
        )}
        {view === "day" && (
          <DayView
            day={selectedDay}
            appts={visibleForView}
            contactById={contactById}
            tx={tx}
            lang={t.lang}
            onOpen={setActiveId}
            activeId={activeId}
            onPickDay={setSelectedDay}
            weekStart={weekStart}
          />
        )}
      </div>

      {activeAppt && (
        <SidePanel
          appt={activeAppt}
          contactById={contactById}
          team={team}
          tx={tx}
          lang={t.lang}
          onClose={() => setActiveId(null)}
          onOpenConversation={() => {
            setActiveId(null);
            setRoute("inbox");
          }}
          onChangeStatus={handleStatusChange}
          statusUpdating={statusBusy}
          statusError={statusError}
          canUpdate={canUpdate}
          onReschedule={() => setRescheduling(activeAppt)}
        />
      )}

      {showNew && canCreate && (
        <BookingDialog
          contacts={contacts}
          services={services}
          staff={staffList}
          tz={tz}
          tx={tx}
          lang={t.lang}
          date={cal.date < today ? today : cal.date}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            void apptsQ.refetch();
          }}
        />
      )}
      {rescheduling && canUpdate && (
        <RescheduleDialog
          appt={rescheduling}
          services={services}
          staff={staffList}
          tz={tz}
          tx={tx}
          lang={t.lang}
          onClose={() => setRescheduling(null)}
          onSaved={() => {
            setRescheduling(null);
            void apptsQ.refetch();
          }}
        />
      )}

      <style>{`
        .cal-chip { display: inline-flex; align-items: center; gap: 5px;
          height: 28px; padding: 0 12px; border-radius: 999px;
          border: 1px solid var(--line-soft); background: var(--bg-1);
          color: var(--ink-2); font-size: 12px;
          font-family: var(--font-mono); cursor: pointer; }
        .cal-chip:hover { color: var(--ink); border-color: var(--line); }
        .cal-chip.active { background: var(--accent-soft); color: var(--accent);
          border-color: var(--accent-ring); }
        .appt-card { transition: transform 0.08s ease, box-shadow 0.08s ease; }
        .appt-card:hover { box-shadow: var(--shadow-sm); transform: translateY(-1px); }
        .appt-card.active { box-shadow: 0 0 0 2px var(--accent) inset; }
        .day-pill:hover { border-color: var(--line) !important; }
      `}</style>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* SP-10: Schedule | Services | Staff tabs (ruling 11)                      */
/* ─────────────────────────────────────────────────────────────────────── */

/**
 * The calendar route with its catalog tabs. The tab, search, layout and
 * archived filter live in the hash (`#/calendar?tab=services&q=…`). Services
 * and Staff are visible with bookings.view; their writes and the import
 * wizard need bookings.manage. All times are in the workspace timezone.
 */
function CalendarScreen() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { can } = usePermissions();
  const { activeWorkspace } = useAuth();
  const [params, setParams] = useCatalogParams();
  const canView = can("bookings.view");
  const canManage = can("bookings.manage");
  const tz = workspaceTz(activeWorkspace?.timezone);
  const tab: CalendarTab = canView ? params.tab : "schedule";
  const tabs: [CalendarTab, string][] = [
    ["schedule", tx("Schedule", "المواعيد")],
    ["services", tx("Services", "الخدمات")],
    ["staff", tx("Staff", "الموظفون")],
  ];
  return (
    <div>
      {canView && (
        <div className="tabs" role="tablist" aria-label={tx("Calendar sections", "أقسام التقويم")} style={{ padding: "12px 24px 0" }}>
          {tabs.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`tab ${tab === id ? "active" : ""}`.trim()}
              onClick={() => setParams({ tab: id })}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {tab === "schedule" && <CalendarImpl />}
      {tab === "services" && (
        <ServicesTab tx={tx} lang={t.lang} tz={tz} canManage={canManage} params={params} setParams={setParams} />
      )}
      {tab === "staff" && (
        <StaffTab tx={tx} lang={t.lang} tz={tz} canManage={canManage} params={params} setParams={setParams} />
      )}
      <style>{`
        .cal-chip { display: inline-flex; align-items: center; gap: 5px;
          height: 28px; padding: 0 12px; border-radius: 999px;
          border: 1px solid var(--line-soft); background: var(--bg-1);
          color: var(--ink-2); font-size: 12px; cursor: pointer; }
        .cal-chip:hover { color: var(--ink); border-color: var(--line); }
        .cal-chip.active { background: var(--accent-soft); color: var(--accent);
          border-color: var(--accent-ring); }
      `}</style>
    </div>
  );
}

const Calendar = memo(CalendarScreen);
export default Calendar;
