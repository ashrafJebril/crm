import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
// The backend constants are the shared fixture: read as text so the frontend
// never compiles backend code, but a drift in either list fails here.
import backendFields from "../../../backend/src/tickets/ticket-fields.ts?raw";
import {
  CATEGORY_COPY,
  PRIORITY_COPY,
  TICKET_ATTACHMENTS_MAX,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  categoryLabel,
  channelLabel,
  priorityChipShown,
  priorityLabel,
  ticketPriority,
} from "./ticketFields";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

function backendList(name: string): string[] {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(backendFields);
  if (!m) throw new Error(`${name} not found in backend ticket-fields.ts`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("ticketFields", () => {
  it("priority and category labels cover every key in both languages", () => {
    expect([...TICKET_PRIORITIES]).toEqual(backendList("TICKET_PRIORITIES"));
    expect([...TICKET_CATEGORIES]).toEqual(backendList("TICKET_CATEGORIES"));
    expect(backendFields).toContain(`TICKET_ATTACHMENTS_MAX = ${TICKET_ATTACHMENTS_MAX};`);
    expect(Object.keys(PRIORITY_COPY).sort()).toEqual([...TICKET_PRIORITIES].sort());
    expect(Object.keys(CATEGORY_COPY).sort()).toEqual([...TICKET_CATEGORIES].sort());

    const enSeen = new Set<string>();
    const arSeen = new Set<string>();
    for (const p of TICKET_PRIORITIES) {
      const e = priorityLabel(en, p);
      const a = priorityLabel(ar, p);
      expect(e, p).not.toMatch(ARABIC);
      expect(a, p).toMatch(ARABIC);
      enSeen.add(e);
      arSeen.add(a);
    }
    for (const c of TICKET_CATEGORIES) {
      const e = categoryLabel(en, c)!;
      const a = categoryLabel(ar, c)!;
      expect(e, c).not.toMatch(ARABIC);
      expect(e, c).not.toBe(c);
      expect(a, c).toMatch(ARABIC);
      enSeen.add(e);
      arSeen.add(a);
    }
    // Every label is distinct.
    expect(enSeen.size).toBe(TICKET_PRIORITIES.length + TICKET_CATEGORIES.length);
    expect(arSeen.size).toBe(TICKET_PRIORITIES.length + TICKET_CATEGORIES.length);
    // The plan's wording.
    expect(priorityLabel(ar, "urgent")).toBe("عاجلة");
    expect(categoryLabel(en, "data_modification")).toBe("Data change");
  });

  it("legacy and unknown priorities read as normal; empty category is null", () => {
    expect(ticketPriority(undefined)).toBe("normal");
    expect(ticketPriority("medium")).toBe("normal");
    expect(priorityLabel(en, null)).toBe("Normal");
    expect(categoryLabel(en, null)).toBeNull();
    expect(categoryLabel(en, "")).toBeNull();
    expect(categoryLabel(en, "custom_key")).toBe("custom_key");
  });

  it("only high and urgent get a card chip", () => {
    expect(TICKET_PRIORITIES.filter(priorityChipShown)).toEqual(["urgent", "high"]);
    expect(priorityChipShown(undefined)).toBe(false);
  });
});

describe("channelLabel", () => {
  it("is shown only when present, in both languages", () => {
    expect(channelLabel(en, null)).toBeNull();
    expect(channelLabel(en, undefined)).toBeNull();
    expect(channelLabel(en, { kind: "whatsapp", displayName: null })).toBe("WhatsApp");
    expect(channelLabel(ar, { kind: "whatsapp", displayName: "الفرع الرئيسي" })).toBe("واتساب · الفرع الرئيسي");
    expect(channelLabel(ar, { kind: "webchat" })).toMatch(ARABIC);
    expect(channelLabel(en, { kind: "sms", displayName: "" })).toBe("sms");
  });
});
