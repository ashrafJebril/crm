import { describe, it, expect } from "vitest";
import type { Conversation } from "../../lib/types";
import {
  EMPTY_FILTER, matchesFilter, sortConversations, needsAttention, bucketCounts, activeFilterCount,
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
  it("tags come from the contact", () => {
    const f = F({ tags: ["vip"] });
    expect(matchesFilter(mk({ id: "a", contactId: "c1" }), f, ctx)).toBe(true);
    expect(matchesFilter(mk({ id: "a", contactId: "c2" }), f, ctx)).toBe(false);
  });
  it("lifecycle is case-insensitive", () => {
    expect(matchesFilter(mk({ id: "a" }), F({ lifecycles: ["customer"] }), ctx)).toBe(true);
    expect(matchesFilter(mk({ id: "a" }), F({ lifecycles: ["LEAD"] }), ctx)).toBe(false);
  });
  it("date range is inclusive of the to-day", () => {
    const f = F({ from: "2026-11-01", to: "2026-11-03" });
    expect(matchesFilter(mk({ id: "a", updatedAt: "2026-11-03T23:30:00.000Z" }), f, ctx)).toBe(true);
    expect(matchesFilter(mk({ id: "a", updatedAt: "2026-11-01T00:00:00.000Z" }), f, ctx)).toBe(true);
    expect(matchesFilter(mk({ id: "a", updatedAt: "2026-11-04T00:00:00.000Z" }), f, ctx)).toBe(false);
    expect(matchesFilter(mk({ id: "a", updatedAt: "2026-10-31T23:59:59.000Z" }), f, ctx)).toBe(false);
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
    expect(activeFilterCount(F({ labelIds: ["a"], escalatedOnly: true, from: "2026-01-01" }))).toBe(3);
  });
});
