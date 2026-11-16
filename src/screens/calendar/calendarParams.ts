/**
 * SP-10 Schedule-tab URL state (ruling 11):
 * `#/calendar?view=week|day|list|agenda|board&date=YYYY-MM-DD&service=<id>&staff=<id>`
 * beside Task 4's `tab`/`q`/`layout`/`archived`. Defaults stay out of the URL;
 * an old hash without params decodes to today's week view. `date` is a
 * workspace-local calendar date. Pure.
 */
import { setHashParam, splitHash } from "@/lib/hashState";
import type { Lang } from "@/lib/types";
import { MAX_LIST_RANGE_DAYS } from "./bookingConstants";
import { addDays, instantOf, weekdayOf, type Weekday } from "./bookingTime";

export const CALENDAR_VIEWS = ["week", "day", "list", "agenda", "board"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export interface CalendarParams {
  view: CalendarView;
  /** Workspace-local date the view is on. */
  date: string;
  /** Service filter (catalog id) or null. */
  service: string | null;
  /** Staff filter (resource id) or null. */
  staff: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validDate(s: string | null): s is string {
  if (!s || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** `today` is the workspace-local date of now (the default). */
export function parseCalendarParams(hash: string, today: string): CalendarParams {
  const p = splitHash(hash).params;
  const view = p.get("view");
  const date = p.get("date");
  const service = p.get("service");
  const staff = p.get("staff");
  return {
    view: (CALENDAR_VIEWS as readonly string[]).includes(view ?? "") ? (view as CalendarView) : "week",
    date: validDate(date) ? date : today,
    service: service && ID_RE.test(service) ? service : null,
    staff: staff && ID_RE.test(staff) ? staff : null,
  };
}

/** The hash with `patch` applied (date === today and view === week are dropped); other params kept. */
export function withCalendarParams(hash: string, patch: Partial<CalendarParams>, today: string): string {
  let h = hash;
  if (patch.view !== undefined) h = setHashParam(h, "view", patch.view === "week" ? null : patch.view);
  if (patch.date !== undefined) h = setHashParam(h, "date", patch.date === today || !validDate(patch.date) ? null : patch.date);
  if (patch.service !== undefined) h = setHashParam(h, "service", patch.service);
  if (patch.staff !== undefined) h = setHashParam(h, "staff", patch.staff);
  return h;
}

/** First day of the week by language (ruling 11): Saturday in Arabic, Monday in English. */
export function weekStartOf(date: string, lang: Lang): string {
  const order: Weekday[] = lang === "ar" ? ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] : ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  return addDays(date, -order.indexOf(weekdayOf(date)));
}

/** The local dates a view covers (week: 7 days by language; day: one; list/board/agenda follow week). */
export function viewDays(view: CalendarView, date: string, lang: Lang): string[] {
  if (view === "day") return [date];
  const start = weekStartOf(date, lang);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/**
 * The `from`/`to` instants for `GET /appointments` (≤ MAX_LIST_RANGE_DAYS).
 * The week-based views also cover a day each side, so the browser-zone week
 * grid never misses a booking near a boundary; the list looks 91 days ahead.
 */
export function rangeFor(view: CalendarView, date: string, tz: string, lang: Lang): { from: string; to: string } {
  let startDate: string;
  let endDate: string;
  if (view === "day") {
    startDate = addDays(date, -1);
    endDate = addDays(date, 2);
  } else if (view === "list") {
    startDate = weekStartOf(date, lang);
    endDate = addDays(startDate, MAX_LIST_RANGE_DAYS - 1);
  } else {
    const ws = weekStartOf(date, lang);
    startDate = addDays(ws, -1);
    endDate = addDays(ws, 8);
  }
  return { from: instantOf(startDate, 0, tz).toISOString(), to: instantOf(endDate, 0, tz).toISOString() };
}

/** The list query string for a view and its filters. */
export function appointmentsQuery(p: CalendarParams, tz: string, lang: Lang): string {
  const { from, to } = rangeFor(p.view, p.date, tz, lang);
  const q = new URLSearchParams({ from, to, limit: "500" });
  if (p.service) q.set("serviceId", p.service);
  if (p.staff) q.set("resourceId", p.staff);
  return `/appointments?${q.toString()}`;
}
