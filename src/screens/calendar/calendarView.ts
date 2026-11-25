import type { Layout } from "@/styles/breakpoints";
import { CALENDAR_VIEWS, type CalendarView } from "./calendarParams";

/**
 * SP-30 calendar view by layout (pure). Below md the week grid does not fit:
 * phones open on the day view (the agenda, list and board stay one tap
 * away); from md the week view is the default, as before. An explicit view
 * in the URL (the user's choice) wins, except the week grid on a phone.
 */
export function defaultCalendarView(layout: Layout): CalendarView {
  return layout === "phone" ? "day" : "week";
}

/** The `view` param of the hash only when it names a view (else null: no choice made). */
export function explicitCalendarView(raw: string | null | undefined): CalendarView | null {
  return (CALENDAR_VIEWS as readonly string[]).includes(raw ?? "") ? (raw as CalendarView) : null;
}

export function resolveCalendarView(layout: Layout, explicit: CalendarView | null): CalendarView {
  if (layout === "phone") return explicit && explicit !== "week" ? explicit : defaultCalendarView(layout);
  return explicit ?? defaultCalendarView(layout);
}

/** The views a layout offers (the week grid only from md). */
export function calendarViewsFor(layout: Layout): CalendarView[] {
  return CALENDAR_VIEWS.filter((v) => layout !== "phone" || v !== "week");
}
