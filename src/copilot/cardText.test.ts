import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import type { PendingCard } from "@/lib/types";
import { cardStatusText, changeLabel, changeValue, noteText, receiptTarget, toolTitle } from "./cardText";

const en = makeTx("en");
const ar = makeTx("ar");
const card = (over: Partial<PendingCard>): PendingCard => ({
  id: "a1",
  tool: "create_activity",
  title: "create_activity",
  changes: [],
  status: "PENDING",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  refusal: null,
  feedback: null,
  ...over,
});

describe("card wording", () => {
  it("titles, labels and values in both languages, Latin digits", () => {
    expect(toolTitle("move_ticket_stage", ar)).toBe("نقل تذكرة");
    expect(toolTitle("unknown_tool", en)).toBe("unknown_tool");
    expect(changeLabel("ticket.stage", en)).toBe("Stage");
    expect(changeValue("activity.kind", "follow_up", ar, "ar")).toBe("متابعة");
    expect(changeValue("activity.dueAt", "2026-11-18T06:00:00.000Z", ar, "ar")).not.toMatch(/[٠-٩]/);
    expect(changeValue("activity.title", "<b>x</b>", en, "en")).toBe("<b>x</b>");
  });

  it("the status line covers every outcome, including the review keys", () => {
    expect(cardStatusText(card({}), en)).toBeNull();
    expect(cardStatusText(card({ expiresAt: new Date(0).toISOString() }), en)).toBe("Expired");
    expect(cardStatusText(card({ status: "EXECUTED" }), en)).toBe("Done");
    expect(cardStatusText(card({ status: "REJECTED", refusal: "permission_revoked" }), ar)).toBe("تغيّرت صلاحياتك، لذلك لم يُنفَّذ شيء.");
    expect(cardStatusText(card({ status: "REJECTED", refusal: "card_outdated" }), en)).toMatch(/record changed/);
    expect(cardStatusText(card({ status: "REJECTED", refusal: "declined" }), en)).toBe("Declined");
    expect(cardStatusText(card({ status: "FAILED", errorKey: "copilot.action_unknown" }), en)).toBe("Status unknown — check the record.");
    expect(cardStatusText(card({ status: "FAILED", errorKey: "activities.something" }), en)).toMatch(/couldn't be made/);
    expect(cardStatusText(card({ status: "EXPIRED" }), ar)).toBe("انتهت الصلاحية");
  });

  it("receipts link to the record", () => {
    expect(receiptTarget(card({ status: "EXECUTED", result: { activityId: "x", contactId: "c1" } }))).toEqual({ kind: "contact", id: "c1" });
    expect(receiptTarget(card({ status: "EXECUTED", result: { ticketId: "t1", stageId: "s2" } }))).toEqual({ kind: "ticket", id: "t1" });
    expect(receiptTarget(card({ status: "EXECUTED", result: { sourceId: "k1" } }))).toEqual({ href: "#/agent" });
    expect(receiptTarget(card({ status: "PENDING", result: { ticketId: "t1" } }))).toBeNull();
  });

  it("decision notes in the member's language", () => {
    expect(noteText("Approved and done: move_ticket_stage", ar)).toBe("تمت الموافقة والتنفيذ: نقل تذكرة");
    expect(noteText("Not done (permission_revoked): create_activity", en)).toBe("Create an activity: Your permission changed, so nothing was done.");
    expect(noteText("Status unknown: create_activity", en)).toBe("Create an activity: Status unknown — check the record.");
    expect(noteText("something else", en)).toBe("something else");
  });
});
