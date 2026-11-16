/**
 * SP-10 calendar URL state for the catalog tabs (ruling 11):
 * `#/calendar?tab=schedule|services|staff&q=…&layout=cards|table&archived=1`.
 * Defaults are left out of the URL; unknown values fall back to the default.
 * Task 5 adds `view`, `date`, `service` and `staff` on the same hash.
 */
import { setHashParam, splitHash } from "@/lib/hashState";

export const CALENDAR_TABS = ["schedule", "services", "staff"] as const;
export type CalendarTab = (typeof CALENDAR_TABS)[number];
export type StaffLayout = "cards" | "table";

export interface CatalogParams {
  tab: CalendarTab;
  /** Search text of the Services / Staff tab. */
  q: string;
  layout: StaffLayout;
  /** Show archived and paused rows. */
  archived: boolean;
}

export const DEFAULT_CATALOG_PARAMS: CatalogParams = { tab: "schedule", q: "", layout: "cards", archived: false };

export function parseCatalogParams(hash: string): CatalogParams {
  const p = splitHash(hash).params;
  const tab = p.get("tab");
  const layout = p.get("layout");
  return {
    tab: (CALENDAR_TABS as readonly string[]).includes(tab ?? "") ? (tab as CalendarTab) : "schedule",
    q: (p.get("q") ?? "").slice(0, 100),
    layout: layout === "table" ? "table" : "cards",
    archived: p.get("archived") === "1",
  };
}

/** The hash with `patch` applied; other params (Task 5's view/date/filters) are kept. */
export function withCatalogParams(hash: string, patch: Partial<CatalogParams>): string {
  let h = hash;
  const set = (k: string, v: string | null) => (h = setHashParam(h, k, v));
  if (patch.tab !== undefined) {
    set("tab", patch.tab === "schedule" ? null : patch.tab);
    // Search belongs to one tab: switching tabs clears it unless given.
    if (patch.q === undefined) set("q", null);
  }
  if (patch.q !== undefined) set("q", patch.q.trim() ? patch.q.slice(0, 100) : null);
  if (patch.layout !== undefined) set("layout", patch.layout === "cards" ? null : patch.layout);
  if (patch.archived !== undefined) set("archived", patch.archived ? "1" : null);
  return h;
}
