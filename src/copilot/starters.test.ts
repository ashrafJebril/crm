import { describe, expect, it } from "vitest";
import type { Permission } from "@/lib/permissions";
import type { CopilotSession } from "@/lib/types";
import { STARTERS, startersFor } from "./starters";
import { addPage, EMPTY_HISTORY, removeSession } from "./historyPaging";

const ARABIC = /[؀-ۿ]/;
const canAll = () => true;
const only = (...ps: Permission[]) => (p: Permission) => ps.includes(p);

describe("starters are filtered by permission and page in both languages", () => {
  it("every starter has distinct English and Arabic text and at least one permission", () => {
    for (const [page, list] of Object.entries(STARTERS)) {
      for (const s of list) {
        expect({ page, en: ARABIC.test(s.en), ar: ARABIC.test(s.ar), needs: s.needs.length > 0 }).toEqual({ page, en: false, ar: true, needs: true });
      }
    }
  });

  it("the plan's starters per page, filtered by can()", () => {
    expect(startersFor("conversation", canAll, "en")).toEqual([
      "Summarise this conversation",
      "Was the customer's issue resolved?",
      "Draft a reply",
      "Translate this conversation's summary",
    ]);
    // Viewing without sending: no "Draft a reply".
    expect(startersFor("conversation", only("conversations.view"), "en")).not.toContain("Draft a reply");
    expect(startersFor("contact", only("contacts.view"), "en")).toEqual(["Give me a 30-second brief on this customer", "Any open tickets or upcoming bookings?"]);
    expect(startersFor("contact", canAll, "ar")).toContain("أضف متابعة ليوم غد");
    expect(startersFor("ticket", only("contacts.view"), "en")).toEqual([]);
    expect(startersFor("pipeline", only("tickets.view"), "en")).toHaveLength(2);
    expect(startersFor("booking", only("bookings.view"), "ar")).toEqual(["ما الحجوزات المسجّلة غدًا؟", "ما الحجوزات التي ما زالت معلّقة؟"]);
    expect(startersFor("insights_support", only("conversations.view"), "en")).toEqual([]);
    expect(startersFor("insights_support", only("reports.view"), "en")).toEqual(["Why did the AI resolution rate change?"]);
    expect(startersFor("dashboard", canAll, "en")).toEqual(["What changed this week?", "Which conversations need a person now?"]);
    expect(startersFor("followups", canAll, "en")).toEqual(["What's overdue for me?"]);
    expect(startersFor("campaign", only("campaigns.view"), "en")).toEqual(["How did my last campaign do?"]);
    expect(startersFor("knowledge", only("knowledge.view"), "en")).toEqual([]);
    expect(startersFor("other", canAll, "en")).toEqual([]);
  });
});

const sess = (id: string): CopilotSession => ({ id, title: id, updatedAt: "2026-11-17T10:00:00.000Z", running: false });

describe("history page pages by cursor", () => {
  it("appends pages without duplicates and keeps the cursor", () => {
    let s = addPage(EMPTY_HISTORY, { items: [sess("a"), sess("b")], nextCursor: "c1" }, true);
    expect(s).toEqual({ items: [sess("a"), sess("b")], nextCursor: "c1", loaded: true });
    // A chat that moved between pages is not shown twice.
    s = addPage(s, { items: [sess("b"), sess("c")], nextCursor: null }, false);
    expect(s.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(s.nextCursor).toBeNull();
    // Reloading the first page replaces the list.
    s = addPage(s, { items: [sess("z")], nextCursor: "c9" }, true);
    expect(s.items.map((i) => i.id)).toEqual(["z"]);
    expect(removeSession(s, "z").items).toEqual([]);
  });
});
