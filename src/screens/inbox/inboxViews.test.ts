import { describe, expect, it } from "vitest";
import type { Conversation } from "../../lib/types";
import { needsAttention, type FilterCtx, type InboxBucket } from "./inboxFilters";
import {
  AI_MEMBER, MORE_VIEWS, PRIMARY_VIEWS, channelKindsToShow, defaultView, matchesView, parseView, previewPrefix,
  readStoredView, viewCounts, viewForBucket, waitLabel, waitTime, writeStoredView, type ViewId,
} from "./inboxViews";

const ctx: FilterCtx = { meId: "me", contactById: new Map(), isLive: (c) => c.id.startsWith("t_") };
const NOW = Date.parse("2026-11-22T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();
const mk = (o: Partial<Conversation>): Conversation => ({
  id: "c1", contactId: "k1", unread: 0, pinned: false, lastAt: "", lastFrom: "them", preview: "hi",
  channel: "whatsapp", status: "human", intent: "", confidence: 0, updatedAt: ago(5), ...o,
} as Conversation);

describe("inbox views: parsing and the old chips", () => {
  it("parses base, channel and member views; refuses anything else", () => {
    for (const v of [...PRIMARY_VIEWS, ...MORE_VIEWS]) expect(parseView(v)).toBe(v);
    expect(parseView("channel:instagram")).toBe("channel:instagram");
    expect(parseView("member:u_123")).toBe("member:u_123");
    expect(parseView("member:ai")).toBe("member:ai");
    for (const bad of [null, "", "inbox", "channel:", "member:<x>", "channel:a b", "Needs-Reply"]) expect(parseView(bad)).toBeNull();
  });

  it("every old status chip maps to a view with the same rule", () => {
    const buckets: InboxBucket[] = ["all", "mine", "unassigned", "unread", "human", "pending_customer", "resolved", "closed", "spam"];
    const want: Record<InboxBucket, ViewId> = {
      all: "all", mine: "mine", unassigned: "unassigned", unread: "unread", human: "open",
      pending_customer: "pending", resolved: "done", closed: "closed", spam: "spam",
    };
    for (const b of buckets) expect(viewForBucket(b)).toBe(want[b]);
    const list = [
      mk({ id: "a", assigneeId: "me" }),
      mk({ id: "b", status: "pending_customer" }),
      mk({ id: "c", status: "resolved" }),
      mk({ id: "d", status: "closed" }),
      mk({ id: "e", status: "spam" }),
      mk({ id: "f", unread: 3 }),
    ];
    const ids = (v: ViewId) => list.filter((c) => matchesView(c, v, ctx)).map((c) => c.id).join("");
    expect(ids("mine")).toBe("a");
    expect(ids("unassigned")).toBe("bcf");
    expect(ids("open")).toBe("af");
    expect(ids("pending")).toBe("b");
    expect(ids("done")).toBe("c");
    expect(ids("closed")).toBe("d");
    expect(ids("spam")).toBe("e");
    expect(ids("unread")).toBe("f");
    expect(ids("all")).toBe("abcdef");
  });

  it("Needs reply reuses the Needs attention rule exactly", () => {
    const cases = [
      mk({ id: "1" }),
      mk({ id: "2", assigneeId: "x" }),
      mk({ id: "3", escalated: true, assigneeId: "x" }),
      mk({ id: "4", lastFrom: "human" }),
      mk({ id: "5", status: "closed", escalated: true }),
      mk({ id: "t_6" }),
      mk({ id: "7", status: "pending_customer" }),
    ];
    for (const c of cases) expect(matchesView(c, "needs-reply", ctx)).toBe(needsAttention(c, ctx));
  });

  it("channel and member views list open conversations; the AI agent is a member", () => {
    const list = [
      mk({ id: "a", channel: "instagram" }),
      mk({ id: "b", channel: "instagram", status: "resolved" }),
      mk({ id: "c", channel: "facebook", assigneeId: "u1" }),
      mk({ id: "d", aiEnabled: true }),
      mk({ id: "e", aiEnabled: true, aiPausedAt: ago(1) }),
    ];
    const counts = viewCounts(list, ctx, ["instagram", "facebook", "whatsapp"], ["u1", "u2"]);
    expect(counts["channel:instagram"]).toBe(1);
    expect(counts["channel:facebook"]).toBe(1);
    expect(counts["channel:whatsapp"]).toBe(2);
    expect(counts["member:u1"]).toBe(1);
    expect(counts["member:u2"]).toBe(0);
    expect(counts[`member:${AI_MEMBER}`]).toBe(1);
    expect(counts["needs-reply"]).toBe(3); // a, d, e (c is assigned, b is done)
    expect(counts.done).toBe(1);
  });

  it("the Channels group shows connected kinds and kinds with open conversations, in order", () => {
    const counts = { "channel:instagram": 3, "channel:webchat": 0, "channel:telegram": 0 };
    expect(channelKindsToShow(["whatsapp", "instagram", "facebook", "webchat"], new Set(["whatsapp"]), counts)).toEqual(["whatsapp", "instagram"]);
    expect(channelKindsToShow(["whatsapp"], new Set(), {})).toEqual([]);
  });
});

describe("inbox views: default and remembered choice", () => {
  it("Needs reply when someone waits, else All open; a stored choice wins", () => {
    expect(defaultView({ "needs-reply": 2 }, null)).toBe("needs-reply");
    expect(defaultView({ "needs-reply": 0 }, null)).toBe("open");
    expect(defaultView({}, null)).toBe("open");
    expect(defaultView({ "needs-reply": 5 }, "channel:instagram")).toBe("channel:instagram");
  });

  it("remembers per user; blocked or junk storage is ignored", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    writeStoredView(store, "u1", "done");
    expect(readStoredView(store, "u1")).toBe("done");
    expect(readStoredView(store, "u2")).toBeNull();
    mem.set("aram.inbox.view.u3", "<script>");
    expect(readStoredView(store, "u3")).toBeNull();
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readStoredView(blocked, "u1")).toBeNull();
    expect(() => writeStoredView(blocked, "u1", "open")).not.toThrow();
    expect(readStoredView(null, "u1")).toBeNull();
    expect(readStoredView(store, "")).toBeNull();
  });
});

describe("inbox rows: wait time and preview prefix", () => {
  it("waits since the last inbound message; warn over 30 min, bad over 1 h", () => {
    expect(waitTime(mk({ updatedAt: ago(4) }), NOW)).toEqual({ minutes: 4, label: "4m", tone: "none" });
    expect(waitTime(mk({ updatedAt: ago(30) }), NOW)?.tone).toBe("none");
    expect(waitTime(mk({ updatedAt: ago(31) }), NOW)?.tone).toBe("warn");
    expect(waitTime(mk({ updatedAt: ago(60) }), NOW)?.tone).toBe("warn");
    expect(waitTime(mk({ updatedAt: ago(61) }), NOW)).toEqual({ minutes: 61, label: "1h", tone: "bad" });
    // Not waiting on us: our reply was last, or the conversation is done.
    expect(waitTime(mk({ lastFrom: "human" }), NOW)).toBeNull();
    expect(waitTime(mk({ lastFrom: "ai" }), NOW)).toBeNull();
    expect(waitTime(mk({ status: "resolved" }), NOW)).toBeNull();
    expect(waitTime(mk({ updatedAt: undefined }), NOW)).toBeNull();
  });

  it("labels: minutes, hours, then days (Latin digits)", () => {
    expect(waitLabel(0)).toBe("1m");
    expect(waitLabel(59)).toBe("59m");
    expect(waitLabel(60)).toBe("1h");
    expect(waitLabel(47 * 60)).toBe("47h");
    expect(waitLabel(48 * 60)).toBe("2d");
  });

  it("prefixes outbound previews", () => {
    expect(previewPrefix({ lastFrom: "human" })).toBe("you");
    expect(previewPrefix({ lastFrom: "ai" })).toBe("ai");
    expect(previewPrefix({ lastFrom: "them" })).toBeNull();
  });
});
