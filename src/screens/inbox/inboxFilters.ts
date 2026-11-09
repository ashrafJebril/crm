import type { ChannelDto, Conversation } from "../../lib/types";

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
}

export const EMPTY_FILTER: InboxFilter = {
  bucket: "all", assigneeIds: [], labelIds: [], tags: [], lifecycles: [], channelIds: [], escalatedOnly: false,
};

export interface FilterCtx {
  meId: string;
  contactById: Map<string, { tags: string[]; lifecycle: string; name: string }>;
  isLive: (c: Conversation) => boolean;
}

const BUCKETS: InboxBucket[] = [
  "all", "mine", "unassigned", "unread", "human", "pending_customer", "resolved", "closed", "spam",
];

function inBucket(c: Conversation, b: InboxBucket, ctx: FilterCtx): boolean {
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
  if (f.assigneeIds.length && !(c.assigneeId && f.assigneeIds.includes(c.assigneeId))) return false;
  if (f.labelIds.length && !(c.labelIds ?? []).some((l) => f.labelIds.includes(l))) return false;
  if (f.escalatedOnly && !c.escalated) return false;
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

const ts = (c: Conversation) => (c.updatedAt ? Date.parse(c.updatedAt) || 0 : 0);

export function sortConversations(list: Conversation[], sort: InboxSort): Conversation[] {
  const cmp = (a: Conversation, b: Conversation) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (sort === "oldest") return ts(a) - ts(b);
    if (sort === "unread" && a.unread !== b.unread) return b.unread - a.unread;
    return ts(b) - ts(a);
  };
  return [...list].sort(cmp);
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
    (f.lifecycles.length ? 1 : 0) + (f.channelIds.length ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.escalatedOnly ? 1 : 0);
}

export interface NumberTab {
  /** null = "All". */
  id: string | null;
  label: string;
  count: number;
  kind: string | null;
}

/**
 * Tabs for channels whose kind has 2 or more numbers (e.g. two WhatsApp numbers).
 * Counts come from the visible list; conversations without a channel (l-agent)
 * only count under "All". Returns [] when no kind qualifies.
 */
export function numberTabs(
  visible: Conversation[],
  channels: Pick<ChannelDto, "id" | "kind" | "displayName" | "phoneNumber">[],
): NumberTab[] {
  const perKind = new Map<string, number>();
  for (const ch of channels) perKind.set(ch.kind, (perKind.get(ch.kind) ?? 0) + 1);
  const multi = channels.filter((ch) => (perKind.get(ch.kind) ?? 0) >= 2);
  if (multi.length === 0) return [];
  const counts = new Map<string, number>();
  for (const c of visible) if (c.channelId) counts.set(c.channelId, (counts.get(c.channelId) ?? 0) + 1);
  return [
    { id: null, label: "All", count: visible.length, kind: null },
    ...multi.map((ch) => ({
      id: ch.id,
      label: ch.displayName || ch.phoneNumber || ch.kind,
      count: counts.get(ch.id) ?? 0,
      kind: ch.kind,
    })),
  ];
}
