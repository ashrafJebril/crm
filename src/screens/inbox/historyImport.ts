import { CHANNEL_LABEL, type ConvChannel } from "../../lib/types";
import type { Tx } from "../../lib/tx";

/**
 * On-demand Zernio history import (pure helpers). A Zernio thread can be
 * synced with a preview but no stored messages; opening it asks the backend
 * once to import its history (POST
 * /integrations/zernio/db-conversations/:id/import-history), then refetches.
 */

/** What the backend answers. `reason` is set when it imported nothing on purpose. */
export interface HistoryImportResult {
  imported: number;
  skipped?: number;
  reason?: "no_external_id" | "not_zernio" | "channel_unavailable" | "throttled";
}

/** Per conversation: an import is running, or one finished (with what it found). */
export type HistoryImportStatus =
  | { phase: "importing" }
  | { phase: "done"; imported: number; failed: boolean; throttled: boolean };

export const historyImportPath = (id: string) =>
  `/integrations/zernio/db-conversations/${encodeURIComponent(id)}/import-history`;

/**
 * Conversations that already had their one automatic import this session
 * (module scope: survives the Inbox unmounting, so switching screens never
 * re-triggers it). A manual Retry is not limited by it.
 */
const autoAttempted = new Set<string>();
export const autoImportAttempted = (id: string) => autoAttempted.has(id);
export const markAutoImportAttempted = (id: string) => void autoAttempted.add(id);
/** Tests only. */
export const resetAutoImportAttempts = () => autoAttempted.clear();

/**
 * Whether opening `activeId` should start the automatic history import: its
 * own detail has loaded (not the list-row placeholder, not a refetch of
 * another key), holds no messages, it is a DB conversation on a Zernio
 * channel (row or detail says `channelProvider === "zernio"`), and it has not
 * had its one automatic attempt this session.
 */
export function shouldAutoImportHistory(input: {
  activeId: string | null;
  detail: { id: string; messages?: unknown[] | null; channelProvider?: string | null; placeholder?: boolean } | null | undefined;
  rowProvider: string | null | undefined;
  isLiveThread: boolean;
  attempted: (id: string) => boolean;
}): boolean {
  const { activeId, detail } = input;
  if (!activeId || input.isLiveThread) return false;
  if (!detail || detail.id !== activeId || detail.placeholder) return false;
  if (!Array.isArray(detail.messages) || detail.messages.length > 0) return false;
  const provider = input.rowProvider ?? detail.channelProvider ?? null;
  if (provider !== "zernio") return false;
  return !input.attempted(activeId);
}

/**
 * What an empty thread shows. A Zernio thread never shows the bare "no
 * messages yet": it is either loading its history, or honestly says none was
 * found (with Retry).
 */
export type EmptyThreadView = "no-messages" | "importing" | "none-found";

export function emptyThreadView(input: {
  isZernio: boolean;
  status: HistoryImportStatus | undefined;
  autoAttempted: boolean;
}): EmptyThreadView {
  if (!input.isZernio) return "no-messages";
  if (input.status?.phase === "importing") return "importing";
  if (input.status?.phase === "done") return "none-found";
  // Not started here: the automatic attempt is about to run, unless it already
  // ran this session (its outcome lost with an unmounted Inbox).
  return input.autoAttempted ? "none-found" : "importing";
}

/** "Loading history from Instagram…" (the channel's name, else a generic source). */
export function importingLabel(channel: string | null | undefined, tx: Tx): string {
  const name = channel ? CHANNEL_LABEL[channel as ConvChannel] : undefined;
  return name
    ? tx(`Loading history from ${name}…`, `جارٍ تحميل السجل من ${name}…`)
    : tx("Loading history from the channel…", "جارٍ تحميل السجل من القناة…");
}
