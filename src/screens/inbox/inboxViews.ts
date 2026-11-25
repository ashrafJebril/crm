import type { Conversation } from "../../lib/types";
import { inBucket, needsAttention, type FilterCtx, type InboxBucket } from "./inboxFilters";

/**
 * Inbox "views column" (pure). A view is the list's primary scope; the
 * filter menu (assignee, labels, tags, channel kind, number, dates, ads,
 * escalated) refines it, and the sort menu orders it.
 *
 * Every pre-existing status chip is a view:
 *   all → "all"             mine → "mine" (My inbox)
 *   unassigned → "unassigned"   unread → "unread"
 *   human ("Open") → "open" (All open)   pending_customer → "pending"
 *   resolved → "done"       closed → "closed"   spam → "spam"
 * plus "needs-reply" (the old "Needs attention" rule, `needsAttention`),
 * one view per channel kind and one per assignee (and the AI agent).
 * The old channel chips (several kinds at once) live on as the filter
 * menu's "Channel" group.
 */
export type BaseViewId =
  | "mine" | "needs-reply" | "unassigned" | "open" | "done"
  | "unread" | "pending" | "closed" | "spam" | "all";
export type ViewId = BaseViewId | `channel:${string}` | `member:${string}`;

/** The AI agent as a "member" (conversations it is answering). */
export const AI_MEMBER = "ai";

export const PRIMARY_VIEWS: readonly BaseViewId[] = ["mine", "needs-reply", "unassigned", "open", "done"];
/** The "More" group: the remaining old status chips. */
export const MORE_VIEWS: readonly BaseViewId[] = ["unread", "pending", "closed", "spam", "all"];
const BASE = new Set<string>([...PRIMARY_VIEWS, ...MORE_VIEWS]);

const VIEW_BUCKET: Partial<Record<BaseViewId, InboxBucket>> = {
  mine: "mine",
  unassigned: "unassigned",
  open: "human",
  done: "resolved",
  unread: "unread",
  pending: "pending_customer",
  closed: "closed",
  spam: "spam",
  all: "all",
};

/** The view an old `f=` bucket meant (keeps old links working). */
export function viewForBucket(b: InboxBucket): ViewId {
  switch (b) {
    case "mine": return "mine";
    case "unassigned": return "unassigned";
    case "unread": return "unread";
    case "human": return "open";
    case "pending_customer": return "pending";
    case "resolved": return "done";
    case "closed": return "closed";
    case "spam": return "spam";
    default: return "all";
  }
}

/** `view=` hash value → a view, or null (absent or unknown). */
export function parseView(raw: string | null | undefined): ViewId | null {
  if (!raw) return null;
  if (BASE.has(raw)) return raw as BaseViewId;
  const m = /^(channel|member):([A-Za-z0-9_.:-]{1,80})$/.exec(raw);
  return m ? (raw as ViewId) : null;
}

/** Open = waiting on the team (status "human"); channel and member views list these. */
const isOpen = (c: Conversation, ctx: FilterCtx) => inBucket(c, "human", ctx);

/** Is the AI agent answering this conversation (on, not paused by a human reply)? */
export const aiAnswering = (c: Conversation) => c.aiEnabled === true && !c.aiPausedAt;

export function matchesView(c: Conversation, view: ViewId, ctx: FilterCtx): boolean {
  if (view === "needs-reply") return needsAttention(c, ctx);
  if (view.startsWith("channel:")) return isOpen(c, ctx) && c.channel === view.slice(8);
  if (view.startsWith("member:")) {
    const id = view.slice(7);
    if (!isOpen(c, ctx)) return false;
    return id === AI_MEMBER ? aiAnswering(c) : c.assigneeId === id;
  }
  const b = VIEW_BUCKET[view as BaseViewId];
  return b ? inBucket(c, b, ctx) : false;
}

/** Counts for every base view, each channel kind and each member id (plus the AI agent). */
export function viewCounts(
  list: Conversation[],
  ctx: FilterCtx,
  channelKinds: readonly string[],
  memberIds: readonly string[],
): Record<string, number> {
  const views: ViewId[] = [
    ...PRIMARY_VIEWS,
    ...MORE_VIEWS,
    ...channelKinds.map((k) => `channel:${k}` as ViewId),
    ...[...memberIds, AI_MEMBER].map((id) => `member:${id}` as ViewId),
  ];
  const out: Record<string, number> = Object.fromEntries(views.map((v) => [v, 0]));
  for (const c of list) for (const v of views) if (matchesView(c, v, ctx)) out[v]++;
  return out;
}

/**
 * Channel kinds for the "Channels" group: connected ones and any with open
 * conversations, in a stable order (`order` first, then the rest).
 */
export function channelKindsToShow(
  order: readonly string[],
  connected: ReadonlySet<string>,
  counts: Record<string, number>,
): string[] {
  const all = new Set<string>([...connected, ...Object.keys(counts).filter((k) => k.startsWith("channel:")).map((k) => k.slice(8))]);
  const keep = [...all].filter((k) => connected.has(k) || (counts[`channel:${k}`] ?? 0) > 0);
  return keep.sort((a, b) => rank(order, a) - rank(order, b) || a.localeCompare(b));
}
const rank = (order: readonly string[], k: string) => {
  const i = order.indexOf(k);
  return i < 0 ? order.length : i;
};

/**
 * Can this view still be shown? Base views always; a channel view while its
 * kind is connected or has conversations; a member view while the member is
 * on the team (the AI agent always).
 */
export function isViewAvailable(view: ViewId, ctx: { memberIds: readonly string[]; channelKinds: readonly string[] }): boolean {
  if (view.startsWith("member:")) {
    const id = view.slice(7);
    return id === AI_MEMBER || ctx.memberIds.includes(id);
  }
  if (view.startsWith("channel:")) return ctx.channelKinds.includes(view.slice(8));
  return BASE.has(view);
}

/** Default view: Needs reply when someone waits, else All open; a remembered choice wins. */
export function defaultView(counts: Record<string, number>, stored: ViewId | null): ViewId {
  if (stored) return stored;
  return (counts["needs-reply"] ?? 0) > 0 ? "needs-reply" : "open";
}

const STORE_PREFIX = "aram.inbox.view.";

/** The remembered view for a user (storage may be blocked: null then). */
export function readStoredView(storage: Pick<Storage, "getItem"> | null | undefined, userId: string): ViewId | null {
  if (!storage || !userId) return null;
  try {
    return parseView(storage.getItem(STORE_PREFIX + userId));
  } catch {
    return null;
  }
}

export function writeStoredView(storage: Pick<Storage, "setItem"> | null | undefined, userId: string, view: ViewId): void {
  if (!storage || !userId) return;
  try {
    storage.setItem(STORE_PREFIX + userId, view);
  } catch {
    /* blocked or full: the choice is just not remembered */
  }
}

export type WaitTone = "none" | "warn" | "bad";

/**
 * The time of the customer's last message, or null when the list does not
 * carry one. `lastInboundAt` is the only real timestamp: `updatedAt` moves on
 * assign, read, label and pin, and `lastAt` is a display string ("now",
 * "1m"), so it is used only if it happens to be an ISO timestamp.
 */
export function lastInboundTime(c: Pick<Conversation, "lastInboundAt" | "lastAt">): number | null {
  const fromField = c.lastInboundAt ? Date.parse(c.lastInboundAt) : NaN;
  if (Number.isFinite(fromField)) return fromField;
  const fromLastAt = typeof c.lastAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(c.lastAt) ? Date.parse(c.lastAt) : NaN;
  return Number.isFinite(fromLastAt) ? fromLastAt : null;
}

/**
 * How long a conversation has waited on us: since the customer's last
 * message, while the customer spoke last (an AI reply counts as answered, as
 * in Needs reply) and the conversation is still open to a reply. null when it
 * is not waiting or no inbound time is known. Over 30 min → warn, over 1 h → bad.
 */
export function waitTime(c: Conversation, now: number): { minutes: number; label: string; tone: WaitTone } | null {
  if (c.lastFrom !== "them") return null;
  if (c.status === "resolved" || c.status === "closed" || c.status === "spam") return null;
  const at = lastInboundTime(c);
  if (at === null) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  const tone: WaitTone = minutes > 60 ? "bad" : minutes > 30 ? "warn" : "none";
  return { minutes, label: waitLabel(minutes), tone };
}

/** 0–59 → "Nm" (min 1), under 48 h → "Nh", then "Nd" (Latin digits, unit letters in both languages). */
export function waitLabel(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const h = Math.floor(minutes / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "You:" / "AI:" for an outbound last message (null for the customer's). */
export function previewPrefix(c: Pick<Conversation, "lastFrom">): "you" | "ai" | null {
  if (c.lastFrom === "human") return "you";
  if (c.lastFrom === "ai") return "ai";
  return null;
}

/**
 * The view after a hash change into the inbox (Back/Forward, a link):
 * its `view=`; with no `view=` but an `open=` (a notification or record
 * link) the current view stays; else the view of an old `f=` bucket; else
 * null (the default view).
 */
export function viewAfterHashChange(
  hash: { view: string | null; open: string | null; bucket: InboxBucket },
  current: ViewId | null,
): ViewId | null {
  const v = parseView(hash.view);
  if (v) return v;
  if (hash.open) return current;
  return hash.bucket !== "all" ? viewForBucket(hash.bucket) : null;
}

/**
 * A view named by a link (`view=`) or remembered, checked once the team and
 * channels are known: kept when available, else null (the default view).
 * `channelKinds` are the connected kinds plus the kinds of any listed
 * conversation (not the filtered counts, so narrowing the filter menu never
 * drops a channel view).
 */
export function availableViewOrNull(
  view: ViewId | null,
  ctx: { memberIds: readonly string[]; channelKinds: readonly string[] },
): ViewId | null {
  return view && isViewAvailable(view, ctx) ? view : null;
}
