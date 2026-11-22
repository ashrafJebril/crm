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
  reason?: HistoryImportReason;
}

/** Why the backend imported nothing on purpose. */
export type HistoryImportReason =
  | "no_external_id"
  | "not_zernio"
  | "channel_unavailable"
  | "throttled"
  | "has_messages"
  | "busy"
  | "rate_limited";

/** Per conversation: an import is running, or one finished (with what it found). */
export type HistoryImportStatus =
  | { phase: "importing" }
  | { phase: "done"; imported: number; failed: boolean; reason?: HistoryImportReason };

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
 * messages yet" unless the server says there is nothing to import from
 * (not a Zernio thread, no Zernio id, or it already holds messages):
 *  - importing: the import runs (or the automatic one is about to start);
 *  - checking: it was refused as too soon (throttled) or another import of the
 *    workspace was running (busy), with Retry;
 *  - rate-limited: too many imports in the workspace this minute, with Retry;
 *  - failed: the call failed, with Retry;
 *  - channel-off: the channel is not connected;
 *  - none-found: a real import found nothing, with Retry.
 */
export type EmptyThreadView =
  | "no-messages"
  | "importing"
  | "checking"
  | "rate-limited"
  | "failed"
  | "channel-off"
  | "none-found";

export function emptyThreadView(input: {
  isZernio: boolean;
  status: HistoryImportStatus | undefined;
  autoAttempted: boolean;
}): EmptyThreadView {
  if (!input.isZernio) return "no-messages";
  const st = input.status;
  if (st?.phase === "importing") return "importing";
  if (st?.phase === "done") {
    if (st.failed) return "failed";
    switch (st.reason) {
      case "throttled":
      case "busy":
        return "checking";
      case "rate_limited":
        return "rate-limited";
      case "channel_unavailable":
        return "channel-off";
      case "not_zernio":
      case "no_external_id":
      case "has_messages":
        return "no-messages";
      default:
        return "none-found";
    }
  }
  // Not started here: the automatic attempt is about to run, unless it already
  // ran this session (its outcome lost with an unmounted Inbox).
  return input.autoAttempted ? "none-found" : "importing";
}

const channelName = (channel: string | null | undefined) =>
  channel ? CHANNEL_LABEL[channel as ConvChannel] : undefined;

/** The empty state's text and whether it offers Retry (null = the plain empty text). */
export function emptyThreadCopy(
  view: EmptyThreadView,
  channel: string | null | undefined,
  tx: Tx,
): { text: string; retry: boolean } | null {
  const name = channelName(channel);
  switch (view) {
    case "no-messages":
      return null;
    case "importing":
      return { text: importingLabel(channel, tx), retry: false };
    case "checking":
      return { text: tx("Checking history…", "جارٍ التحقق من السجل…"), retry: true };
    case "rate-limited":
      return {
        text: tx(
          "Too many history requests in this workspace. Try again in a minute.",
          "طلبات سجل كثيرة في مساحة العمل هذه. حاول مرة أخرى بعد دقيقة.",
        ),
        retry: true,
      };
    case "failed":
      return { text: tx("Couldn’t load history.", "تعذّر تحميل السجل."), retry: true };
    case "channel-off":
      return {
        text: name
          ? tx(`The ${name} channel isn’t connected.`, `قناة ${name} غير متصلة.`)
          : tx("This channel isn’t connected.", "هذه القناة غير متصلة."),
        retry: false,
      };
    case "none-found":
      return {
        text: tx("No message history found for this conversation.", "لم يُعثر على سجل رسائل لهذه المحادثة."),
        retry: true,
      };
  }
}

/** "Loading history from Instagram…" (the channel's name, else a generic source). */
export function importingLabel(channel: string | null | undefined, tx: Tx): string {
  const name = channelName(channel);
  return name
    ? tx(`Loading history from ${name}…`, `جارٍ تحميل السجل من ${name}…`)
    : tx("Loading history from the channel…", "جارٍ تحميل السجل من القناة…");
}
