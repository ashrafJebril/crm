import type { Layout } from "@/styles/breakpoints";

/**
 * SP-30 inbox phone pattern (pure). Below md one pane shows at a time:
 * the list, the thread of the selected conversation, or its details (the
 * contact rail as a full-screen pane). From md every pane is on screen
 * ("all"); between md and lg the details open as a sheet over the thread.
 */
export type InboxPane = "list" | "thread" | "details" | "all";

export function inboxPane(layout: Layout, s: { selected: boolean; detailsOpen: boolean }): InboxPane {
  if (layout !== "phone") return "all";
  if (!s.selected) return "list";
  return s.detailsOpen ? "details" : "thread";
}

/** Between md and lg the contact rail is a sheet (opened from the thread) instead of a column. */
export function detailsAsSheet(layout: Layout): boolean {
  return layout === "tablet";
}

/** The hash params that carry the phone panes, so Back walks thread → list (and details → thread). */
export const PANE_CONV_PARAM = "c";
export const PANE_DETAILS_PARAM = "d";
