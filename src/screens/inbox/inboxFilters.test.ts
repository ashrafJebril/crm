process.env.TZ = "Asia/Dubai";
import { describe, it, expect } from "vitest";
import type { Conversation } from "../../lib/types";
import {
  EMPTY_FILTER, matchesFilter, sortConversations, needsAttention, bucketCounts, activeFilterCount, numberTabs,
  type FilterCtx, type InboxFilter,
} from "./inboxFilters";

const mk = (o: Partial<Conversation> & { id: string }): Conversation => ({
  contactId: "c1", unread: 0, pinned: false, lastAt: "", lastFrom: "them", preview: "",
  channel: "whatsapp", status: "human", intent: "", confidence: 0, ...o,
} as Conversation);
const ctx: FilterCtx = {
  meId: "me",
  contactById: new Map([
    ["c1", { tags: ["vip"], lifecycle: "Customer", name: "A" }],
    ["c2", { tags: ["new"], lifecycle: "Lead", name: "B" }],
  ]),
  isLive: (c) => c.id.startsWith("t_") || c.id.startsWith("ig:"),
};
const F = (o: Partial<InboxFilter>): InboxFilter => ({ ...EMPTY_FILTER, ...o });

describe("inboxFilters", () => {
  it("mine excludes live FB/IG threads and others' threads", () => {
    const f = F({ bucket: "mine" });
    expect(matchesFilter(mk({ id: "a", assigneeId: "me" }), f, ctx)).toBe(true);
    expect(matchesFilter(mk({ id: "t_1", assigneeId: "me" }), f, ctx)).toBe(false);
    expect(matchesFilter(mk({ id: "ig:1", assigneeId: "me" }), f, ctx)).toBe(false);
    expect(matchesFilter(mk({ id: "b", assigneeId: "other" }), f, ctx)).toBe(false);
  });
  it("all keeps live threads", () => {
    expect(matchesFilter(mk({ id: "t_1" }), EMPTY_FILTER, ctx)).toBe(true);
  });
  it("labels match any", () => {
    const f = F({ labelIds: ["l1", "l2"] });
    expect(matchesFilter(mk({ id: "a", labelIds: ["l2"] }), f, ctx)).toBe(true);
    expect(matchesFilter(mk({ id: "a", labelIds: ["l3"] }), f, ctx)).toBe(false);
    expect(matchesFilter(mk({ id: "a" }), f, ctx)).toBe(false);
  });
  it("an invalid updatedAt never matches a date filter", () => {
    const bad = mk({ id: "bad", updatedAt: "not-a-date" });
    expect(matchesFilter(bad, F({ from: "2026-11-01" }), ctx)).toBe(false);
    expect(matchesFilter(bad, F({ to: "2026-11-30" }), ctx)).toBe(false);
    expect(matchesFilter(bad, F({}), ctx)).toBe(true);
  });

  it("tags come from the contact", () => {
    const f = F({ tags: ["vip"] });
    expect(matchesFilter(mk({ id: "a", contactId: "c1" }), f, ctx)).toBe(true);
    expect(matchesFilter(mk({ id: "a", contactId: "c2" }), f, ctx)).toBe(false);
  });
  it("lifecycle is case-insensitive", () => {
    expect(matchesFilter(mk({ id: "a" }), F({ lifecycles: ["customer"] }), ctx)).toBe(true);
    expect(matchesFilter(mk({ id: "a" }), F({ lifecycles: ["LEAD"] }), ctx)).toBe(false);
  });
  it("date range is inclusive of the to-day, using the local (Dubai) day", () => {
    const f = F({ from: "2026-11-01", to: "2026-11-03" });
    const at = (u: string) => matchesFilter(mk({ id: "a", updatedAt: u }), f, ctx);
    expect(at("2026-10-31T20:30:00Z")).toBe(true); // 1 Nov 00:30 Dubai
    expect(at("2026-10-31T19:30:00Z")).toBe(false); // 31 Oct 23:30 Dubai
    expect(at("2026-11-03T19:30:00Z")).toBe(true); // 3 Nov 23:30 Dubai
    expect(at("2026-11-03T20:30:00Z")).toBe(false); // 4 Nov 00:30 Dubai
    expect(matchesFilter(mk({ id: "a" }), f, ctx)).toBe(false);
  });
  it("pinned stays first in every sort", () => {
    const list = [
      mk({ id: "new", updatedAt: "2026-11-05T00:00:00Z", unread: 5 }),
      mk({ id: "pin", pinned: true, updatedAt: "2026-11-01T00:00:00Z" }),
      mk({ id: "old", updatedAt: "2026-11-02T00:00:00Z" }),
    ];
    const copy = [...list];
    for (const s of ["recent", "oldest", "unread"] as const) {
      expect(sortConversations(list, s)[0].id).toBe("pin");
    }
    expect(sortConversations(list, "recent").map((c) => c.id)).toEqual(["pin", "new", "old"]);
    expect(sortConversations(list, "oldest").map((c) => c.id)).toEqual(["pin", "old", "new"]);
    expect(list).toEqual(copy);
  });
  it("needsAttention flags escalated and unassigned waiting threads", () => {
    expect(needsAttention(mk({ id: "a", escalated: true }), ctx)).toBe(true);
    expect(needsAttention(mk({ id: "a" }), ctx)).toBe(true);
    expect(needsAttention(mk({ id: "a", assigneeId: "x" }), ctx)).toBe(false);
    expect(needsAttention(mk({ id: "a", lastFrom: "human" }), ctx)).toBe(false);
    expect(needsAttention(mk({ id: "t_1", escalated: true }), ctx)).toBe(false);
    expect(needsAttention(mk({ id: "a", status: "closed", escalated: true }), ctx)).toBe(false);
    expect(needsAttention(mk({ id: "a", status: "spam" }), ctx)).toBe(false);
  });
  it("bucketCounts counts each bucket in one pass", () => {
    const list = [
      mk({ id: "a", assigneeId: "me", unread: 2 }),
      mk({ id: "b" }),
      mk({ id: "c", status: "closed" }),
      mk({ id: "t_1", unread: 1 }),
      mk({ id: "d", status: "pending_customer", assigneeId: "x" }),
    ];
    expect(bucketCounts(list, ctx)).toEqual({
      all: 5, mine: 1, unassigned: 1, unread: 2, human: 3,
      pending_customer: 1, resolved: 0, closed: 1, spam: 0,
    });
  });
  it("activeFilterCount excludes bucket", () => {
    expect(activeFilterCount(F({ bucket: "mine" }))).toBe(0);
    expect(activeFilterCount(F({ labelIds: ["a"], escalatedOnly: true, from: "2026-01-01", to: "2026-01-02" }))).toBe(3);
  });
});

describe("number tabs (SP-19)", () => {
  const ch = (id: string, kind: string, displayName = id, phoneNumber: string | null = null, status = "active") =>
    ({ id, kind, displayName, phoneNumber, status, externalId: `ext-${id}` }) as any;
  const two = [ch("w1", "whatsapp", "Main", "+971500000001"), ch("w2", "whatsapp", "", "+971500000002")];

  it("number tab filters by channelId", () => {
    expect(matchesFilter(mk({ id: "a", channelId: "w1" }), EMPTY_FILTER, ctx, "w1")).toBe(true);
    expect(matchesFilter(mk({ id: "a", channelId: "w2" }), EMPTY_FILTER, ctx, "w1")).toBe(false);
    expect(matchesFilter(mk({ id: "a", channelId: null }), EMPTY_FILTER, ctx, "w1")).toBe(false);
    expect(matchesFilter(mk({ id: "a", channelId: null }), EMPTY_FILTER, ctx, null)).toBe(true);
  });
  it("channelIds filter intersects with tab", () => {
    const f = F({ channelIds: ["w1", "w2"] });
    expect(matchesFilter(mk({ id: "a", channelId: "w1" }), f, ctx, "w1")).toBe(true);
    expect(matchesFilter(mk({ id: "a", channelId: "w2" }), f, ctx, "w1")).toBe(false);
    expect(matchesFilter(mk({ id: "a", channelId: "w3" }), f, ctx, null)).toBe(false);
    expect(matchesFilter(mk({ id: "a", channelId: "w2" }), F({ channelIds: ["w1"] }), ctx, "w2")).toBe(false);
  });
  it("counts the number filter as one active filter", () => {
    expect(activeFilterCount(F({ channelIds: ["w1", "w2"] }))).toBe(1);
  });
  it("numberTabs counts only visible conversations", () => {
    const visible = [
      mk({ id: "1", channelId: "w1" }), mk({ id: "2", channelId: "w1" }),
      mk({ id: "3", channelId: "w2" }), mk({ id: "4", channelId: null, channel: "l" }),
    ];
    expect(numberTabs(visible, two)).toEqual([
      { id: null, label: "All", count: 4, kind: null },
      { id: "w1", label: "Main", count: 2, kind: "whatsapp" },
      { id: "w2", label: "+971500000002", count: 1, kind: "whatsapp" },
    ]);
  });
  it("hides tabs below two numbers of one kind and ignores other kinds", () => {
    expect(numberTabs([], [ch("w1", "whatsapp")])).toEqual([]);
    expect(numberTabs([], [ch("w1", "whatsapp"), ch("t1", "telegram")])).toEqual([]);
    const tabs = numberTabs([], [ch("w1", "whatsapp"), ch("w2", "whatsapp"), ch("t1", "telegram")]);
    expect(tabs.map((t) => t.id)).toEqual([null, "w1", "w2"]);
  });
  it("m3: only active or needs_attention channels get a tab", () => {
    const tabs = numberTabs([], [
      ch("w1", "whatsapp", "Main", null, "active"),
      ch("w2", "whatsapp", "Old", null, "disconnected"),
      ch("w3", "whatsapp", "Merged", null, "merged"),
      ch("w4", "whatsapp", "Pending", null, "pending"),
    ]);
    expect(tabs).toEqual([]);
    const two = numberTabs([], [ch("w1", "whatsapp", "Main"), ch("w2", "whatsapp", "Two", null, "needs_attention"), ch("w3", "whatsapp", "Gone", null, "disconnected")]);
    expect(two.map((t) => t.id)).toEqual([null, "w1", "w2"]);
  });
  it("I1: tabs for two numbers sharing a name are told apart", () => {
    const tabs = numberTabs([], [ch("w1", "whatsapp", "Shop", "+971500000001"), ch("w2", "whatsapp", "Shop", null)]);
    expect(tabs.map((t) => t.label)).toEqual(["All", "Shop · +971500000001", "Shop · #t-w2"]);
  });
});

describe("matchesFilter keeps only conversations from the chosen ads", () => {
  const fromA = mk({ id: "a", adSourceId: "adA", channelId: "w1" });
  const fromB = mk({ id: "b", adSourceId: "adB", channelId: "w2" });
  const organic = mk({ id: "c", adSourceId: null, channelId: "w1" });
  const legacy = mk({ id: "d", channelId: "w1" });
  const all = [fromA, fromB, organic, legacy];
  const ids = (f: InboxFilter, tab: string | null = null) => all.filter((c) => matchesFilter(c, f, ctx, tab)).map((c) => c.id);

  it("any keeps attributed rows, none keeps the others", () => {
    expect(ids(F({ adFilter: "any" }))).toEqual(["a", "b"]);
    expect(ids(F({ adFilter: "none" }))).toEqual(["c", "d"]);
    expect(ids(F({}))).toEqual(["a", "b", "c", "d"]);
  });

  it("ids keep matching adSourceId", () => {
    expect(ids(F({ adSourceIds: ["adB"] }))).toEqual(["b"]);
    expect(ids(F({ adSourceIds: ["adA", "adB"] }))).toEqual(["a", "b"]);
    expect(ids(F({ adSourceIds: ["zzz"] }))).toEqual([]);
  });

  it("combines with the number tab and other filters", () => {
    expect(ids(F({ adFilter: "any" }), "w1")).toEqual(["a"]);
    expect(ids(F({ adFilter: "none" }), "w1")).toEqual(["c", "d"]);
    expect(ids(F({ adSourceIds: ["adA", "adB"], channelIds: ["w2"] }))).toEqual(["b"]);
    expect(ids(F({ adFilter: "any", bucket: "unread" }))).toEqual([]);
  });

  it("activeFilterCount counts it once", () => {
    expect(activeFilterCount(F({ adFilter: "any" }))).toBe(1);
    expect(activeFilterCount(F({ adSourceIds: ["adA", "adB"] }))).toBe(1);
    expect(activeFilterCount(F({ adFilter: "any", adSourceIds: ["adA"] }))).toBe(1);
    expect(activeFilterCount(F({ adFilter: "none", escalatedOnly: true }))).toBe(2);
    expect(activeFilterCount(EMPTY_FILTER)).toBe(0);
  });
});
