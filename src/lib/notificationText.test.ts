import { describe, expect, it } from "vitest";
import { notificationText } from "./notificationText";
import { makeTx } from "./tx";

const en = makeTx("en");
const ar = makeTx("ar");
const base = { type: "assignment", recordKind: null, recordId: null };

describe("notificationText", () => {
  it("renders assignment.conversation with params", () => {
    const r = notificationText(en, { ...base, title: "assignment.conversation", body: JSON.stringify({ contactName: "Sara" }) });
    expect(r.title).toBe("Conversation assigned to you");
    expect(r.body).toBe("Sara");
  });
  it("renders assignment.ticket in Arabic", () => {
    const r = notificationText(ar, { ...base, title: "assignment.ticket", body: JSON.stringify({ ticketTitle: "عرض سعر" }) });
    expect(r.title).toContain("تذكرة");
    expect(r.body).toBe("عرض سعر");
  });
  it("renders mention.note excerpt", () => {
    const r = notificationText(en, { type: "mention", title: "mention.note", body: JSON.stringify({ excerpt: "hello" }), recordKind: "contact", recordId: "c1" });
    expect(r.title).toBe("You were mentioned in a note");
    expect(r.body).toBe("hello");
  });
  it("names the actor when actorName is present, in both languages", () => {
    const conv = { ...base, title: "assignment.conversation", body: JSON.stringify({ actorName: "Sara", contactName: "Ahmad" }) };
    expect(notificationText(en, conv)).toEqual({ title: "Sara assigned you a conversation with Ahmad" });
    expect(notificationText(ar, conv)).toEqual({ title: "أسندت إليك Sara محادثة مع Ahmad" });
    const tk = { ...base, title: "assignment.ticket", body: JSON.stringify({ actorName: "Sara", ticketTitle: "Quote" }) };
    expect(notificationText(en, tk).title).toBe("Sara assigned you a ticket: Quote");
    const mn = { type: "mention", title: "mention.note", body: JSON.stringify({ actorName: "Sara", excerpt: "hi" }), recordKind: null, recordId: null };
    expect(notificationText(en, mn)).toEqual({ title: "Sara mentioned you in a note", body: "hi" });
  });
  it("maps import.failed in both languages", () => {
    const n = { type: "import_finished", title: "import.failed", body: "{}", recordKind: null, recordId: null };
    expect(notificationText(en, n)).toEqual({ title: "An import failed" });
    expect(notificationText(ar, n)).toEqual({ title: "فشل الاستيراد" });
  });
  it("tolerates missing or malformed body", () => {
    expect(notificationText(en, { ...base, title: "assignment.ticket", body: "{oops" }).body).toBeUndefined();
    expect(notificationText(en, { ...base, title: "assignment.ticket", body: null }).body).toBeUndefined();
  });
  it("falls back by type for later key-shaped titles", () => {
    const r = notificationText(en, { type: "campaign_finished", title: "campaign.done_x", body: null, recordKind: null, recordId: null });
    expect(r.title).toBe("A campaign has finished");
  });
  it("shows raw title for unknown plain text", () => {
    expect(notificationText(en, { type: "weird", title: "Hello there", body: null, recordKind: null, recordId: null })).toEqual({ title: "Hello there" });
  });
  it("renders activity.due and assignment.activity in both languages", () => {
    const due = { type: "activity_due", title: "activity.due", body: JSON.stringify({ title: "Call back", contactName: "Sara" }) };
    expect(notificationText(en, due)).toEqual({ title: "Follow-up due: Call back", body: "Sara" });
    expect(notificationText(ar, due).title).toBe("موعد متابعة: Call back");
    const call = { ...due, body: JSON.stringify({ title: "Ring", kind: "call" }) };
    expect(notificationText(en, call).title).toBe("Call due: Ring");
    expect(notificationText(ar, call).title).toBe("موعد مكالمة: Ring");
    expect(notificationText(en, { ...due, body: JSON.stringify({ title: "Q", kind: "meeting" }) }).title).toBe("Meeting due: Q");
    expect(notificationText(en, { ...due, body: JSON.stringify({ title: "Q", kind: "task" }) }).title).toBe("Task due: Q");
    expect(notificationText(ar, { ...due, body: JSON.stringify({ title: "Q", kind: "task" }) }).title).toBe("موعد مهمة: Q");
    const asg = { ...base, title: "assignment.activity", body: JSON.stringify({ title: "Send quote", contactName: "Sara" }) };
    expect(notificationText(en, asg)).toEqual({ title: "Activity assigned to you: Send quote", body: "Sara" });
    expect(notificationText(ar, asg).title).toBe("أُسند إليك نشاط: Send quote");
    const bulk = { ...base, title: "assignment.activity", body: JSON.stringify({ title: "x", count: 3 }) };
    expect(notificationText(en, bulk).title).toBe("3 activities assigned to you");
  });
});
