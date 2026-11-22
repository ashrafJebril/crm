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
