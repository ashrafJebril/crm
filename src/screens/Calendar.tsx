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
import { LIMIT_NOTICE, appointmentsQuery, hitListLimit, viewDays, type CalendarView } from "./calendar/calendarParams";
import { calendarViewsFor, explicitCalendarView, resolveCalendarView } from "./calendar/calendarView";
import { useViewport } from "@/lib/useViewport";
import { getHashParam } from "@/lib/hashState";
import "@/styles/screens/calendar.css";
import {
  apptTop,
  bucketByDay,
  dateShort,
  dayLabel,
  dayNumber,
  dayOfAppt,
  groupByDay,
  rangeLabel,
  timeOf,
  weekStats,
  weekdayShort,
} from "./calendar/calendarGrid";
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

// SP-10 final review I1/I2: days are workspace-local "YYYY-MM-DD" strings
// from the same viewDays the fetch uses; times and day buckets come from the
// workspace zone (calendar/calendarGrid.ts), never the browser's.
const fmtTime = (instant: Date | string, tz: string) => timeOf(instant, tz);

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
  tz: string;
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

function ApptCard({ appt, contactById, lang, tz, onOpen, active }: ApptCardProps) {
  const v = statusVisual(appt.status);
  const contact = contactById.get(appt.contactId);
  // Position in the workspace zone (I2).
  const top = apptTop(appt.startAt, tz, DAY_START_HOUR, HOUR_PX);
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
        <bdi>{fmtTime(appt.startAt, tz)}</bdi>
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
  /** The week's local days (viewDays: the same days the fetch covers). */
  days: string[];
  today: string;
  tz: string;
  appts: Appointment[];
  contactById: Map<string, Contact>;
  tx: Tx;
  lang: "en" | "ar";
  onOpen: (id: string) => void;
  activeId: string | null;
}

function WeekView({
  days,
  today,
  tz,
  appts,
  contactById,
  tx,
  lang,
  onOpen,
  activeId,
}: WeekViewProps) {
  const apptsByDay = useMemo(() => bucketByDay(appts, days, tz), [appts, days, tz]);

  const hours = useMemo(
    () =>
      Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => DAY_START_HOUR + i),
    [],
  );

  return (
    <div className="card cal-week">
      <div
        className="cal-week-grid"
        style={{
          borderBottom: "1px solid var(--line-soft)",
          background: "var(--bg-1)",
        }}
      >
        <div />
        {days.map((d) => {
          const isToday = d === today;
          return (
            <div
              key={d}
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
                {weekdayShort(d, lang)}
              </div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: isToday ? "var(--accent)" : "var(--ink)",
                  letterSpacing: "-0.01em",
                }}
              >
                <bdi>{dayNumber(d)}</bdi>
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
        className="cal-week-grid cal-week-body"
        style={{
          position: "relative",
          maxHeight: HOUR_PX * TOTAL_HOURS + 20,
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
        {days.map((d) => {
          const dayAppts = apptsByDay.get(d) ?? [];
          return (
            <div
              key={d}
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
                  tz={tz}
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
  day: string;
  /** The week strip: the same local days the week grid draws. */
  days: string[];
  today: string;
  tz: string;
  appts: Appointment[];
  contactById: Map<string, Contact>;
  tx: Tx;
  lang: "en" | "ar";
  onOpen: (id: string) => void;
  activeId: string | null;
  onPickDay: (d: string) => void;
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
  days,
  today,
  tz,
}: DayViewProps) {
  const dayAppts = useMemo(() => bucketByDay(appts, [day], tz).get(day) ?? [], [appts, day, tz]);
  const hours = useMemo(
    () =>
      Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => DAY_START_HOUR + i),
    [],
  );
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
            {day === today
              ? tx("Today", "اليوم")
              : tx("Selected day", "اليوم المحدد")}
          </div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            {dayLabel(day, lang)}
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
        {days.map((d) => {
          const isActive = d === day;
          const isToday = d === today;
          return (
            <button
              key={d}
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
                {weekdayShort(d, lang)}
              </span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                <bdi>{dayNumber(d)}</bdi>
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
              tz={tz}
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
  tz: string;
  today: string;
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
  tz,
  today,
}: ListViewProps) {
  const groups = useMemo(() => groupByDay(appts, tz).map((g) => ({ key: g.day, ...g })), [appts, tz]);

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
        const isPast = day < today;
        return (
          <div key={key} className="card cal-list-card">
            <div
              className="card-h"
              style={{
                opacity: isPast ? 0.7 : 1,
              }}
            >
              <div>
                <h3>{dayLabel(day, lang)}</h3>
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
              {day === today && (
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
                          <bdi>{fmtTime(a.startAt, tz)}</bdi>
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
  tz: string;
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
  tz,
}: SidePanelProps) {
  const start = new Date(appt.startAt);
  const end = new Date(start.getTime() + appt.durationMin * 60_000);
  const startDay = dayOfAppt(appt.startAt, tz);
  const contact = contactById.get(appt.contactId);
  const staff = appt.staffId
    ? team.find((m) => m.id === appt.staffId)
    : undefined;
  const service = lang === "ar" ? appt.serviceAr : appt.service;
  const note = lang === "ar" ? appt.noteAr ?? appt.note : appt.note;

  return (
    <aside
      className="cal-panel"
      style={{
        background: "var(--bg-1)",
        borderInlineStart: "1px solid var(--line-soft)",
        boxShadow: "var(--shadow-lg)",
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
                {dayLabel(startDay, lang)}
              </div>
              <div
                className="mono"
                style={{ fontSize: 11, color: "var(--ink-3)" }}
              >
                <bdi>{fmtTime(start, tz)} – {fmtTime(end, tz)}</bdi> · {appt.durationMin}{" "}
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
                {dateShort(startDay, lang)}
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
  // SP-30: phones open on the day view; an explicit view in the URL wins (not the week grid on a phone).
  const { layout } = useViewport();
  const view: ViewMode = resolveCalendarView(layout, explicitCalendarView(getHashParam(window.location.hash, "view")));
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
  // One source of truth for the week (I1): the same local days the fetch covers.
  const selectedDay = cal.date;
  const weekDays = useMemo(() => viewDays("week", cal.date, t.lang), [cal.date, t.lang]);
  const setSelectedDay = (d: string) => setCal({ date: d });

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

  const stats = useMemo(() => weekStats(appointments, weekDays, today, tz), [appointments, weekDays, today, tz]);

  const filtered = useMemo(() => {
    const week = new Set(weekDays);
    return appointments.filter((a) => {
      switch (filter) {
        case "confirmed":
          return a.status === "confirmed";
        case "pending":
          return a.status === "pending";
        case "today":
          return dayOfAppt(a.startAt, tz) === today;
        case "week":
          return week.has(dayOfAppt(a.startAt, tz));
        case "all":
        default:
          return true;
      }
    });
  }, [filter, weekDays, appointments, today, tz]);

  const visibleForView = useMemo(() => {
    if (view === "list") return filtered;
    if (view === "week") {
      const week = new Set(weekDays);
      return filtered.filter((a) => week.has(dayOfAppt(a.startAt, tz)));
    }
    return filtered.filter((a) => dayOfAppt(a.startAt, tz) === selectedDay);
  }, [filtered, view, weekDays, selectedDay, tz]);

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

  const allTabs: Array<{ id: ViewMode; label: string; icon: ReactNode }> = [
    { id: "week", label: tx("Week", "أسبوع"), icon: <IconCal w={14} /> },
    { id: "list", label: tx("List", "قائمة"), icon: <IconUsers w={14} /> },
    { id: "day", label: tx("Day", "يوم"), icon: <IconClock w={14} /> },
    { id: "agenda", label: tx("Agenda", "الأجندة"), icon: <IconCal w={14} /> },
    { id: "board", label: tx("Board", "اللوحة"), icon: <IconUsers w={14} /> },
  ];
  // The week grid is offered from md.
  const tabs = allTabs.filter((tab) => calendarViewsFor(layout).includes(tab.id));

  return (
    <div className="cal-page">
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
                <bdi>{rangeLabel(weekDays[0], weekDays[6], t.lang)}</bdi>
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

        {hitListLimit(appointments.length) && (
          <div role="status" style={{ padding: "8px 12px", fontSize: 12, color: "var(--warn)", border: "1px solid var(--warn)", borderRadius: 8 }}>
            {tx(...LIMIT_NOTICE)}
          </div>
        )}

        {/* Stats */}
        <div className="cal-stats">
          <MiniStat
            label={tx("Today", "اليوم")}
            value={String(stats.todayCount)}
            sub={tx("Scheduled today", "محجوز اليوم")}
            icon={<IconClock w={12} />}
          />
          <MiniStat
            label={tx("This week", "هذا الأسبوع")}
            value={String(stats.weekCount)}
            sub={rangeLabel(weekDays[0], weekDays[6], t.lang)}
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
          <div className="tabs cal-view-tabs" style={{ padding: 0, border: 0 }}>
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
            days={weekDays}
            today={today}
            tz={tz}
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
            tz={tz}
            today={today}
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
            days={weekDays}
            today={today}
            tz={tz}
          />
        )}
      </div>

      {activeAppt && (
        <SidePanel
          tz={tz}
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
