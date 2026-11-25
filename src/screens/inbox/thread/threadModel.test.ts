import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import {
  UNDO_WINDOW_MS,
  canUndoNow,
  eventText,
  filterSavedReplies,
  mergePage,
  pickReplyBody,
  seamLabel,
  slashQuery,
  undoErrorText,
  type SavedReply,
  type ThreadEventItem,
  type ThreadItem,
} from "./threadModel";

const msg = (id: string, at: string): ThreadItem => ({
  type: "message", id, at, conversationId: "c1", channel: "whatsapp",
  message: { from: "them", t: "", body: id },
});
const seam = (id: string, at: string): ThreadItem => ({
  type: "seam", id, at, conversationId: id, channel: "instagram", startedAt: at,
});
const stage = (over: Record<string, unknown> = {}): ThreadEventItem => ({
  type: "event", id: "a1", kind: "stage_changed", at: "2026-11-10T10:00:00.000Z", ticketId: "t1",
  undoable: true,
  data: {
    ticketNumber: 12, ticketTitle: "Banner", fromStage: "new", toStage: "won",
    fromLabel: "New", fromLabelAr: "جديد", toLabel: "Won", toLabelAr: "تم الفوز", note: null,
    ...over,
  },
});

describe("mergePage", () => {
  it("appends an older page after the loaded items", () => {
    const merged = mergePage([msg("m3", "3"), msg("m2", "2")], [msg("m1", "1")]);
    expect(merged.map((i) => i.id)).toEqual(["m3", "m2", "m1"]);
  });
  it("dedupes by type+id and keeps first-seen order", () => {
    const merged = mergePage([msg("m3", "3"), msg("m2", "2")], [msg("m2", "2"), msg("m1", "1")]);
    expect(merged.map((i) => i.id)).toEqual(["m3", "m2", "m1"]);
  });
  it("treats the same id under a different type as a different item", () => {
    const merged = mergePage([msg("x", "2")], [seam("x", "1")]);
    expect(merged).toHaveLength(2);
  });
  it("dedupes inside a single page too", () => {
    expect(mergePage([], [msg("a", "1"), msg("a", "1")])).toHaveLength(1);
  });
});

describe("seamLabel", () => {
  it("names the channel in English", () => {
    expect(seamLabel("whatsapp", "en")).toBe("Conversation started on WhatsApp");
  });
  it("names the channel in Arabic", () => {
    expect(seamLabel("instagram", "ar")).toBe("بدأت المحادثة على إنستغرام");
  });
  it("falls back to the raw channel for unknown or null channels", () => {
    expect(seamLabel("sms", "en")).toBe("Conversation started on sms");
    expect(seamLabel(null, "en")).toBe("Conversation started");
    expect(seamLabel(null, "ar")).toBe("بدأت المحادثة");
  });
});

describe("eventText", () => {
  const en = makeTx("en");
  const ar = makeTx("ar");
  it("describes a stage move with localized stage labels", () => {
    expect(eventText(stage(), en)).toBe("Ticket #12 moved from New to Won");
    expect(eventText(stage(), ar)).toBe("نُقلت التذكرة #12 من جديد إلى تم الفوز");
  });
  it("falls back to the English label when the Arabic one is empty", () => {
    expect(eventText(stage({ fromLabelAr: "" }), ar)).toContain("New");
  });
  it("describes an undo", () => {
    expect(eventText(stage({ isUndo: true }), en)).toBe("Ticket #12 move undone, back to Won");
  });
  it("describes ticket and booking events", () => {
    const base = { type: "event" as const, id: "e", at: "x", data: { ticketNumber: 4, service: "Cut", serviceAr: "قص", status: "cancelled" } };
    expect(eventText({ ...base, kind: "ticket_created" }, en)).toBe("Ticket #4 created");
    expect(eventText({ ...base, kind: "ticket_won" }, en)).toBe("Ticket #4 won");
    expect(eventText({ ...base, kind: "ticket_lost" }, en)).toBe("Ticket #4 lost");
    expect(eventText({ ...base, kind: "booking_created" }, en)).toBe("Booking created: Cut");
    expect(eventText({ ...base, kind: "booking_created" }, ar)).toBe("تم إنشاء حجز: قص");
    expect(eventText({ ...base, kind: "booking_status" }, en)).toBe("Booking cancelled: Cut");
  });
  it("describes a finished activity", () => {
    const e: ThreadItem = { type: "event", id: "e", at: "x", kind: "activity_done", data: { activityKind: "call", title: "Follow up" } };
    expect(eventText(e, en)).toBe("Call done: Follow up");
  });
  it("never throws on missing data", () => {
    const e: ThreadItem = { type: "event", id: "e", at: "x", kind: "stage_changed", data: {} };
    expect(typeof eventText(e, en)).toBe("string");
  });
});

describe("undo window", () => {
  const at = "2026-11-10T10:00:00.000Z";
  const t0 = Date.parse(at);
  it("is 10 minutes", () => expect(UNDO_WINDOW_MS).toBe(600_000));
  it("allows an undoable event inside the window", () => {
    expect(canUndoNow({ undoable: true, at }, t0 + 9 * 60_000)).toBe(true);
  });
  it("blocks after the window", () => {
    expect(canUndoNow({ undoable: true, at }, t0 + UNDO_WINDOW_MS + 1)).toBe(false);
  });
  it("blocks events the server marked not undoable", () => {
    expect(canUndoNow({ undoable: false, at }, t0)).toBe(false);
    expect(canUndoNow({ at }, t0)).toBe(false);
  });
  it("blocks on an unparsable timestamp", () => {
    expect(canUndoNow({ undoable: true, at: "nope" }, t0)).toBe(false);
  });
});

describe("undoErrorText", () => {
  const en = makeTx("en");
  it("maps the 409/403 keys", () => {
    expect(undoErrorText("tickets.undo_expired", en)).toMatch(/10 minutes/);
    expect(undoErrorText("tickets.undo_not_latest", en)).toMatch(/latest/i);
    expect(undoErrorText("tickets.undo_not_allowed", en)).toMatch(/Lost/);
    expect(undoErrorText("tickets.undo_not_author", en)).toMatch(/author|who moved/i);
  });
  it("returns null for unknown keys", () => {
    expect(undoErrorText("whatever", en)).toBeNull();
  });
});

describe("saved replies helpers", () => {
  const replies: SavedReply[] = [
    { id: "1", title: "Greeting", body: "Hello!", bodyAr: "أهلاً!", shortcut: "hi", createdAt: "", updatedAt: "" },
    { id: "2", title: "Hours", body: "We open at 9", bodyAr: null, shortcut: "hours", createdAt: "", updatedAt: "" },
    { id: "3", title: "Thanks", body: "Thank you", bodyAr: null, shortcut: "thanks", createdAt: "", updatedAt: "" },
  ];
  it("slashQuery only opens for a leading slash with no whitespace", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/ho")).toBe("ho");
    expect(slashQuery("/Ho")).toBe("ho");
    expect(slashQuery("hello /ho")).toBeNull();
    expect(slashQuery("/ho now")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
  it("filters by shortcut prefix first, then substring of shortcut or title", () => {
    expect(filterSavedReplies(replies, "").map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(filterSavedReplies(replies, "h").map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(filterSavedReplies(replies, "ho").map((r) => r.id)).toEqual(["2"]);
    expect(filterSavedReplies(replies, "zzz")).toEqual([]);
  });
  it("picks the body in the UI language with fallback to the other", () => {
    expect(pickReplyBody(replies[0], "ar")).toBe("أهلاً!");
    expect(pickReplyBody(replies[0], "en")).toBe("Hello!");
    expect(pickReplyBody(replies[1], "ar")).toBe("We open at 9");
    expect(pickReplyBody({ ...replies[1], body: "", bodyAr: "مرحبا" }, "en")).toBe("مرحبا");
  });
});
