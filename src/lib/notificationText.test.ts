import { describe, expect, it } from "vitest";
import { notificationText } from "./notificationText";
import { makeTx } from "./tx";
import { notificationHref, recordHref } from "./recordLink";

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
  it("renders campaign.launch_failed with the campaign name and the worded error", () => {
    const n = {
      type: "campaign_finished",
      title: "campaign.launch_failed",
      body: JSON.stringify({ name: "Eid offer", error: "campaigns.no_reachable_recipients" }),
      recordKind: "campaign",
      recordId: "c1",
    };
    const e = notificationText(en, n);
    expect(e.title).toBe("Campaign “Eid offer” couldn't be sent");
    expect(e.body).toBe(
      "No one in the audience could receive it: no usable number, opted out, or a missing value without a fallback.",
    );
    const a = notificationText(ar, n);
    expect(a.title).toMatch(/[؀-ۿ]/);
    expect(a.title).toContain("Eid offer");
    expect(a.body).toMatch(/[؀-ۿ]/);
    // No name, no error: still worded, never the raw key.
    expect(notificationText(en, { ...n, body: null })).toEqual({ title: "A campaign couldn't be sent" });
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

describe("health downgrade notification text and deep link", () => {
  const n = (body: unknown) => ({
    type: "connector_needs_attention",
    title: "channel.health_downgraded",
    body: JSON.stringify(body),
    recordKind: null,
    recordId: null,
  });

  it("names the number and words the first change, the rest in the body", () => {
    const one = n({ channelId: "ch1", name: "Sales", phone: "+962790000001", changes: [{ signal: "quality", from: "GREEN", to: "YELLOW" }] });
    expect(notificationText(en, one)).toEqual({ title: "Sales needs attention: quality dropped to Medium" });
    expect(notificationText(ar, one)).toEqual({ title: "Sales يحتاج إلى انتباه: انخفضت الجودة إلى متوسطة" });
    const many = n({
      channelId: "ch1",
      name: "Sales",
      changes: [
        { signal: "messaging", from: "AVAILABLE", to: "BLOCKED" },
        { signal: "templatesBad", from: 0, to: 2 },
        { signal: "tier", from: "TIER_1K", to: "TIER_250" },
      ],
    });
    expect(notificationText(en, many)).toEqual({
      title: "Sales needs attention: messaging is blocked",
      body: "2 templates paused or disabled; the daily limit dropped to 250 / day",
    });
    const a = notificationText(ar, many);
    expect(a.title).toBe("Sales يحتاج إلى انتباه: المراسلة محظورة");
    expect(a.body).toContain("تم إيقاف قالبين أو تعطيلهما");
  });

  it("words every signal in both languages", () => {
    const changes = [
      { signal: "quality", to: "RED" },
      { signal: "messaging", to: "LIMITED" },
      { signal: "phoneStatus", to: "FLAGGED" },
      { signal: "nameStatus", to: "DECLINED" },
      { signal: "accountReview", to: "REJECTED" },
      { signal: "tier", to: "TIER_50" },
      { signal: "templatesBad", to: 1 },
    ];
    for (const ch of changes) {
      const e = notificationText(en, n({ channelId: "c", name: "N", changes: [ch] })).title;
      const r = notificationText(ar, n({ channelId: "c", name: "N", changes: [ch] })).title;
      // Worded per signal: never the generic fallback, never a raw value.
      expect(e, ch.signal).not.toContain("its health changed");
      if (typeof ch.to === "string") expect(e, ch.signal).not.toContain(ch.to);
      expect(r, ch.signal).toMatch(/[؀-ۿ]/);
    }
  });

  it("falls back to the phone, and with no changes still says it needs attention", () => {
    expect(notificationText(en, n({ channelId: "c", phone: "+1", changes: [] }))).toEqual({ title: "+1 needs attention" });
    expect(notificationText(ar, n({ channelId: "c" })).title).toBe("رقم واتساب يحتاج إلى انتباه");
  });

  it("deep links to the channel; other titles keep recordHref", () => {
    expect(notificationHref(n({ channelId: "ch 1" }), "#/inbox")).toBe("#/channels?id=ch%201");
    expect(notificationHref({ ...n({}), body: "not json" }, "#/inbox")).toBe("#/channels");
    const other = { type: "mention", title: "mention.note", body: null, recordKind: "contact", recordId: "c1" };
    expect(notificationHref(other, "#/pipeline")).toBe(recordHref("contact", "c1", "#/pipeline"));
    expect(notificationHref({ ...other, recordKind: null }, "#/pipeline")).toBeNull();
    // Other titles are unchanged by the new case.
    expect(notificationText(en, { ...base, title: "import.failed", body: null })).toEqual({ title: "An import failed" });
  });
});
