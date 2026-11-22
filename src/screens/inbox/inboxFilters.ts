import type { ChannelDto, Conversation } from "../../lib/types";
import { channelLabels } from "../channels/channelModel";

export type InboxView = "list" | "table" | "board";
export type InboxSort = "recent" | "oldest" | "unread";
export type InboxBucket =
  | "all" | "mine" | "unassigned" | "unread" | "human"
  | "pending_customer" | "resolved" | "closed" | "spam";

export interface InboxFilter {
  bucket: InboxBucket;
  assigneeIds: string[];
  labelIds: string[];
  tags: string[];
  lifecycles: string[];
  /** SP-19 "Number" filter: effective channel ids (any of). */
  channelIds: string[];
  from?: string;
  to?: string;
  escalatedOnly: boolean;
  /** SP-15 "Ad source": any ad / no ad (null = off). */
  adFilter: "any" | "none" | null;
  /** SP-15: specific ads (`Conversation.adSourceId`, any of). */
  adSourceIds: string[];
  /** Inbox views: conversation channel kinds (whatsapp, instagram, …; any of) — the old channel chips. */
  kinds: string[];
}

export const EMPTY_FILTER: InboxFilter = {
  bucket: "all", assigneeIds: [], labelIds: [], tags: [], lifecycles: [], channelIds: [], escalatedOnly: false,
  adFilter: null, adSourceIds: [], kinds: [],
};

export interface FilterCtx {
  meId: string;
  contactById: Map<string, { tags: string[]; lifecycle: string; name: string }>;
  isLive: (c: Conversation) => boolean;
}

const BUCKETS: InboxBucket[] = [
  "all", "mine", "unassigned", "unread", "human", "pending_customer", "resolved", "closed", "spam",
];

export function inBucket(c: Conversation, b: InboxBucket, ctx: FilterCtx): boolean {
  switch (b) {
    case "all": return true;
    case "mine": return !ctx.isLive(c) && !!c.assigneeId && c.assigneeId === ctx.meId;
    case "unassigned":
      return !ctx.isLive(c) && !c.assigneeId && c.status !== "closed" && c.status !== "spam";
    case "unread": return c.unread > 0;
    default: return c.status === b;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local calendar day (YYYY-MM-DD) of an instant, as the user sees it. */
const localDay = (iso: string): string | null => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** `numberTab` is the active number tab's channel id (null = All); it intersects with `f.channelIds`. */
export function matchesFilter(
  c: Conversation, f: InboxFilter, ctx: FilterCtx, numberTab: string | null = null,
): boolean {
  if (!inBucket(c, f.bucket, ctx)) return false;
  if (numberTab && c.channelId !== numberTab) return false;
  if (f.channelIds.length && !(c.channelId && f.channelIds.includes(c.channelId))) return false;
  if (f.kinds?.length && !f.kinds.includes(c.channel)) return false;
  if (f.assigneeIds.length && !(c.assigneeId && f.assigneeIds.includes(c.assigneeId))) return false;
  if (f.labelIds.length && !(c.labelIds ?? []).some((l) => f.labelIds.includes(l))) return false;
  if (f.escalatedOnly && !c.escalated) return false;
  if (f.adSourceIds.length) {
    if (!(c.adSourceId && f.adSourceIds.includes(c.adSourceId))) return false;
  } else if (f.adFilter === "any" && !c.adSourceId) return false;
  else if (f.adFilter === "none" && c.adSourceId) return false;
  if (f.tags.length || f.lifecycles.length) {
    const contact = ctx.contactById.get(c.contactId);
    if (f.tags.length && !(contact?.tags ?? []).some((t) => f.tags.includes(t))) return false;
    if (f.lifecycles.length) {
      const lc = (contact?.lifecycle ?? "").toLowerCase();
      if (!f.lifecycles.some((l) => l.toLowerCase() === lc)) return false;
    }
  }
  if (f.from || f.to) {
    if (!c.updatedAt) return false;
    const d = localDay(c.updatedAt);
    if (d === null) return false;
    if (f.from && d < f.from.slice(0, 10)) return false;
    if (f.to && d > f.to.slice(0, 10)) return false;
  }
  return true;
}

const parse = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
/** The newest message time; `updatedAt` only when the list has none (it moves on read, assign, label, pin). */
const messageTime = (c: Conversation): number => parse(c.lastMessageAt) ?? parse(c.updatedAt) ?? 0;

/**
 * Pinned first, then:
 * - "recent" (Newest): the newest message first;
 * - "oldest" (Oldest waiting): the customer's last message, oldest first;
 *   conversations without one go last;
 * - "unread" (Unread first): unread ones first, then the newest message.
 * Ties break on the id, so the order is stable.
 */
export function sortConversations(list: Conversation[], sort: InboxSort): Conversation[] {
  const cmp = (a: Conversation, b: Conversation) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (sort === "oldest") {
      const ia = parse(a.lastInboundAt);
      const ib = parse(b.lastInboundAt);
      if (ia === null || ib === null) {
        if (ia !== ib) return ia === null ? 1 : -1;
      } else if (ia !== ib) return ia - ib;
    } else {
      if (sort === "unread") {
        const ua = a.unread > 0;
        const ub = b.unread > 0;
        if (ua !== ub) return ua ? -1 : 1;
      }
      const d = messageTime(b) - messageTime(a);
      if (d !== 0) return d;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  return [...list].sort(cmp);
}

/**
 * Keep the open conversation where it was: `list` without it, with it put
 * back at `index` (clamped). A new message elsewhere, or the open chat being
 * read, assigned or labelled, then never moves it under the user.
 */
export function keepAt<T extends { id: string }>(list: T[], id: string | null, index: number | null): T[] {
  if (!id || index === null) return list;
  const at = list.findIndex((c) => c.id === id);
  if (at < 0 || at === index) return list;
  const rest = list.filter((c) => c.id !== id);
  const out = [...rest];
  out.splice(Math.max(0, Math.min(index, rest.length)), 0, list[at]!);
  return out;
}

export function needsAttention(c: Conversation, ctx: FilterCtx): boolean {
  if (ctx.isLive(c) || c.status === "closed" || c.status === "spam") return false;
  return !!c.escalated || (c.status === "human" && c.lastFrom === "them" && !c.assigneeId);
}

export function bucketCounts(list: Conversation[], ctx: FilterCtx): Record<InboxBucket, number> {
  const out = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<InboxBucket, number>;
  for (const c of list) for (const b of BUCKETS) if (inBucket(c, b, ctx)) out[b]++;
  return out;
}

export function activeFilterCount(f: InboxFilter): number {
  return (f.assigneeIds.length ? 1 : 0) + (f.labelIds.length ? 1 : 0) + (f.tags.length ? 1 : 0) +
    (f.lifecycles.length ? 1 : 0) + (f.channelIds.length ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.escalatedOnly ? 1 : 0) +
    (f.adFilter || f.adSourceIds.length ? 1 : 0) + (f.kinds?.length ? 1 : 0);
}

export interface NumberTab {
  /** null = "All". */
  id: string | null;
  label: string;
  count: number;
  kind: string | null;
}

/** m3: channels that get a number tab (live ones; not disconnected, merged or pending). */
const TAB_STATUSES: ReadonlySet<string> = new Set(["active", "needs_attention"]);

/**
 * Tabs for channels whose kind has 2 or more live numbers (status active or
 * needs_attention; e.g. two WhatsApp numbers). Counts come from the visible
 * list; conversations without a channel (l-agent) only count under "All".
 * Labels tell apart numbers sharing a name (channelLabels). Returns [] when
 * no kind qualifies.
 */
export function numberTabs(
  visible: Conversation[],
  channels: Pick<ChannelDto, "id" | "kind" | "displayName" | "phoneNumber" | "externalId" | "status">[],
): NumberTab[] {
  const live = channels.filter((ch) => TAB_STATUSES.has(ch.status));
  const perKind = new Map<string, number>();
  for (const ch of live) perKind.set(ch.kind, (perKind.get(ch.kind) ?? 0) + 1);
  const multi = live.filter((ch) => (perKind.get(ch.kind) ?? 0) >= 2);
  if (multi.length === 0) return [];
  const labels = channelLabels(multi);
  const counts = new Map<string, number>();
  for (const c of visible) if (c.channelId) counts.set(c.channelId, (counts.get(c.channelId) ?? 0) + 1);
  return [
    { id: null, label: "All", count: visible.length, kind: null },
    ...multi.map((ch) => ({
      id: ch.id,
      label: labels.get(ch.id) ?? ch.kind,
      count: counts.get(ch.id) ?? 0,
      kind: ch.kind,
    })),
  ];
}
