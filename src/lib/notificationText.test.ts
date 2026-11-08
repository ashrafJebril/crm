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
});
