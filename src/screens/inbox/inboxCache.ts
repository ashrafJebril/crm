import type { Conversation } from "../../lib/types";

/**
 * Opening a conversation (pure helpers). The list is not reloaded on open:
 * marking it read patches the cached list in place, and the thread opens at
 * once from the list row while its messages load (a cached detail of the same
 * conversation is shown straight away).
 */

/** The list with one conversation marked read (same array when nothing changes). */
export function clearUnread<T extends Pick<Conversation, "id" | "unread">>(list: T[] | null, id: string): T[] | null {
  if (!list) return list;
  let changed = false;
  const next = list.map((c) => {
    if (c.id !== id || c.unread === 0) return c;
    changed = true;
    return { ...c, unread: 0 };
  });
  return changed ? next : list;
}

/** Mark read on the server, then patch the cached list; the list is never refetched for it. */
export async function markReadAndPatch(
  id: string,
  post: (path: string) => Promise<unknown>,
  setList: (fn: (prev: Conversation[] | null) => Conversation[] | null) => void,
): Promise<void> {
  await post(`/conversations/${encodeURIComponent(id)}/read`);
  setList((prev) => clearUnread(prev, id));
}

/**
 * The thread to show for \`activeId\`: its loaded detail when that is the same
 * conversation (a placeholder from the previous key never shows the wrong
 * thread), else the list row with no messages yet (the header, name and
 * channel show instantly), else nothing.
 */
export function threadFor<D extends { id: string; messages?: unknown[] }>(
  activeId: string | null,
  detail: D | null | undefined,
  row: Conversation | undefined,
): (D | (Conversation & { messages: never[]; placeholder: true })) | undefined {
  if (!activeId) return undefined;
  if (detail && detail.id === activeId) return detail;
  return row && row.id === activeId ? { ...row, messages: [], placeholder: true } : undefined;
}

/** A conversation's detail stays fresh this long, so going back to it is instant. */
export const DETAIL_STALE_MS = 30_000;

// ─── Review fixes ─────────────────────────────────────────────────────────

/** The path of a conversation's detail (its cache entries are keyed under it). */
export const detailPath = (id: string) => `/conversations/${id}`;

/**
 * A message landed in (or something changed on) a conversation: mark every
 * cached detail of it stale, so the next open refetches even inside the fresh
 * window. An open thread refetches at once.
 */
export function invalidateConversationDetail(
  qc: { invalidateQueries: (f: { queryKey: readonly unknown[] }) => Promise<unknown> },
  id: string,
): Promise<unknown> {
  return qc.invalidateQueries({ queryKey: [detailPath(id)] });
}

/**
 * A cached detail is stale when the list row says a newer message exists
 * than the newest one in the cache (a missed realtime event, another tab).
 */
export function isDetailStale(
  detail: { messages?: Array<{ createdAt?: string | null }> } | null | undefined,
  row: Pick<Conversation, "lastMessageAt"> | undefined,
): boolean {
  if (!detail || !row?.lastMessageAt) return false;
  const rowAt = Date.parse(row.lastMessageAt);
  if (!Number.isFinite(rowAt)) return false;
  let newest = -Infinity;
  for (const m of detail.messages ?? []) {
    const t = m.createdAt ? Date.parse(m.createdAt) : NaN;
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return rowAt > newest;
}

/** Hover intent before a detail is prefetched (sweeping across rows fetches nothing). */
export const HOVER_PREFETCH_MS = 150;

/**
 * Row prefetch: on hover only after HOVER_PREFETCH_MS (cancelled on leave);
 * on keyboard focus at once.
 */
export function createRowPrefetcher(
  prefetch: (id: string) => void,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
) {
  let pending: unknown = null;
  const leave = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
  return {
    enter(id: string) {
      leave();
      pending = timers.set(() => {
        pending = null;
        prefetch(id);
      }, HOVER_PREFETCH_MS);
    },
    leave,
    focus(id: string) {
      leave();
      prefetch(id);
    },
  };
}

/** How long a "read here" mark overrides list responses. */
export const LOCAL_READ_MS = 60_000;

/**
 * Conversations read here at time T: a list response that started before the
 * read (and still says unread > 0) is shown as read, unless the customer wrote
 * after T. Marks older than LOCAL_READ_MS are dropped (and pruned from `reads`).
 */
export function applyLocalReads<T extends Pick<Conversation, "id" | "unread" | "lastInboundAt">>(
  list: T[],
  reads: Map<string, number>,
  now: number,
): T[] {
  for (const [id, at] of reads) if (now - at > LOCAL_READ_MS) reads.delete(id);
  if (reads.size === 0) return list;
  let changed = false;
  const out = list.map((c) => {
    const at = reads.get(c.id);
    if (at === undefined || c.unread === 0) return c;
    const inbound = c.lastInboundAt ? Date.parse(c.lastInboundAt) : NaN;
    if (Number.isFinite(inbound) && inbound > at) return c;
    changed = true;
    return { ...c, unread: 0 };
  });
  return changed ? out : list;
}
