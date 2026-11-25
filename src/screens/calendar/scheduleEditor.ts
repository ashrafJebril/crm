/**
 * SP-10 weekly schedule editor model. Pure: the editor component renders it
 * and dispatches actions; `toSchedule` is what the API receives (the backend
 * shape), and `dayErrors` mirrors the backend's validation per day, so the
 * row the server would reject is the row that is highlighted.
 */
import { MAX_WINDOWS_PER_DAY } from "./bookingConstants";
import { WEEKDAYS, hhmm, parseHHMM, type Weekday } from "./bookingTime";
import { validateSchedule, type ScheduleError, type ScheduleWindow, type WeeklySchedule } from "./schedule";

export interface DayModel {
  on: boolean;
  windows: ScheduleWindow[];
}
export type EditorModel = Record<Weekday, DayModel>;

export type EditorAction =
  | { type: "toggle"; day: Weekday }
  | { type: "add"; day: Weekday }
  | { type: "remove"; day: Weekday; index: number }
  | { type: "set"; day: Weekday; index: number; field: "from" | "to"; value: string }
  | { type: "copy"; from: Weekday; to: Weekday[] }
  | { type: "reset"; schedule: WeeklySchedule };

export const DEFAULT_WINDOW: ScheduleWindow = { from: "09:00", to: "17:00" };

export function fromSchedule(schedule: WeeklySchedule | null | undefined): EditorModel {
  const out = {} as EditorModel;
  for (const d of WEEKDAYS) {
    const ws = schedule?.[d] ?? [];
    out[d] = { on: ws.length > 0, windows: ws.map((w) => ({ ...w })) };
  }
  return out;
}

/** The API shape: days that are on with their windows, in the order the user entered them. */
export function toSchedule(model: EditorModel): WeeklySchedule {
  const out: WeeklySchedule = {};
  for (const d of WEEKDAYS) {
    const day = model[d];
    if (day.on && day.windows.length) out[d] = day.windows.map((w) => ({ from: w.from, to: w.to }));
  }
  return out;
}

/** A sensible next window: after the last one, an hour long, capped at midnight. */
function nextWindow(ws: ScheduleWindow[]): ScheduleWindow {
  if (!ws.length) return { ...DEFAULT_WINDOW };
  const lastEnd = parseHHMM(ws[ws.length - 1].to) ?? 17 * 60;
  const from = Math.min(lastEnd, 23 * 60);
  return { from: hhmm(from), to: hhmm(Math.min(from + 60, 1440)) };
}

export function reduce(model: EditorModel, a: EditorAction): EditorModel {
  if (a.type === "reset") return fromSchedule(a.schedule);
  const next = { ...model };
  if (a.type === "copy") {
    const src = model[a.from];
    for (const d of a.to) if (d !== a.from) next[d] = { on: src.on, windows: src.windows.map((w) => ({ ...w })) };
    return next;
  }
  const day = { ...model[a.day], windows: model[a.day].windows.map((w) => ({ ...w })) };
  switch (a.type) {
    case "toggle":
      day.on = !day.on;
      if (day.on && !day.windows.length) day.windows = [{ ...DEFAULT_WINDOW }];
      break;
    case "add":
      if (day.windows.length >= MAX_WINDOWS_PER_DAY) return model;
      day.windows.push(nextWindow(day.windows));
      day.on = true;
      break;
    case "remove":
      day.windows.splice(a.index, 1);
      if (!day.windows.length) day.on = false;
      break;
    case "set":
      if (!day.windows[a.index]) return model;
      day.windows[a.index] = { ...day.windows[a.index], [a.field]: a.value };
      break;
  }
  next[a.day] = day;
  return next;
}

/** Per-day errors with the backend's reasons; `index` is the row in the editor. */
export function dayErrors(model: EditorModel): Partial<Record<Weekday, ScheduleError>> {
  const out: Partial<Record<Weekday, ScheduleError>> = {};
  for (const d of WEEKDAYS) {
    if (!model[d].on) continue;
    const r = validateSchedule({ [d]: model[d].windows });
    if (!r.ok) out[d] = r.error;
  }
  return out;
}

export const hasErrors = (model: EditorModel) => Object.keys(dayErrors(model)).length > 0;

/** A server-side `bookings.schedule_invalid {day, index, reason}` as editor errors (the editor shows it on that row). */
export function serverError(body: unknown): Partial<Record<Weekday, ScheduleError>> | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.message !== "bookings.schedule_invalid" || typeof b.day !== "string") return null;
  if (!(WEEKDAYS as readonly string[]).includes(b.day)) return null;
  return {
    [b.day as Weekday]: {
      day: b.day,
      index: typeof b.index === "number" ? b.index : null,
      reason: b.reason as ScheduleError["reason"],
    },
  };
}
