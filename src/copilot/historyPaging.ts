/**
 * SP-18 history paging (pure): the server pages the member's own chats by a
 * keyset cursor (updatedAt, id; HISTORY_PAGE per page). Pages are appended
 * without duplicates (a chat updated between pages moves to the top and is
 * not shown twice); a deleted chat leaves the list.
 */
import type { CopilotSession, CopilotSessionPage } from "@/lib/types";

export interface HistoryState {
  items: CopilotSession[];
  nextCursor: string | null;
  /** True once the first page arrived. */
  loaded: boolean;
}

export const EMPTY_HISTORY: HistoryState = { items: [], nextCursor: null, loaded: false };

/** The first page replaces the list; a later page (its cursor matched) is appended, deduped by id. */
export function addPage(s: HistoryState, page: CopilotSessionPage, first: boolean): HistoryState {
  if (first) return { items: dedupe(page.items), nextCursor: page.nextCursor, loaded: true };
  const seen = new Set(s.items.map((i) => i.id));
  return { items: [...s.items, ...page.items.filter((i) => !seen.has(i.id))], nextCursor: page.nextCursor, loaded: true };
}

export function removeSession(s: HistoryState, id: string): HistoryState {
  return { ...s, items: s.items.filter((i) => i.id !== id) };
}

function dedupe(items: CopilotSession[]): CopilotSession[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}
