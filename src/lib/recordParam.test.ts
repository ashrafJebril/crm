import { describe, expect, it } from "vitest";
import { closeRecordHash, isRecordKind, parseRecordParam, recordNavTarget, withRecord } from "./recordParam";

describe("isRecordKind", () => {
  it("accepts the five kinds only", () => {
    for (const k of ["contact", "conversation", "ticket", "booking", "campaign"]) expect(isRecordKind(k)).toBe(true);
    for (const k of ["foo", "", "Contact", "bogus", null, undefined, 3]) expect(isRecordKind(k)).toBe(false);
  });
});

describe("parseRecordParam", () => {
  it("reads kind and id", () => {
    expect(parseRecordParam("#/contacts?record=contact:p1")).toEqual({ kind: "contact", id: "p1" });
    expect(parseRecordParam("#/inbox?f=abc&record=ticket%3At_1&v=2")).toEqual({ kind: "ticket", id: "t_1" });
  });
  it("keeps colons inside the id", () => {
    expect(parseRecordParam("#/inbox?record=conversation:a:b")).toEqual({ kind: "conversation", id: "a:b" });
  });
  it("ignores unknown kinds, empty ids and malformed values", () => {
    expect(parseRecordParam("#/inbox?record=foo")).toBeNull();
    expect(parseRecordParam("#/inbox?record=ticket:")).toBeNull();
    expect(parseRecordParam("#/inbox?record=bogus:1")).toBeNull();
    expect(parseRecordParam("#/inbox?record=:1")).toBeNull();
    expect(parseRecordParam("#/inbox?record=")).toBeNull();
    expect(parseRecordParam("#/inbox?record=%E0%A4%A")).toBeNull();
    expect(parseRecordParam("#/inbox")).toBeNull();
    expect(parseRecordParam("")).toBeNull();
  });
});

describe("withRecord", () => {
  it("sets the record and preserves f, cf, v and open", () => {
    const h = "#/inbox?f=AAA&cf=BBB&v=2&open=x";
    const out = withRecord(h, { kind: "contact", id: "p1" });
    expect(parseRecordParam(out)).toEqual({ kind: "contact", id: "p1" });
    const sp = new URLSearchParams(out.slice(out.indexOf("?") + 1));
    expect(sp.get("f")).toBe("AAA");
    expect(sp.get("cf")).toBe("BBB");
    expect(sp.get("v")).toBe("2");
    expect(sp.get("open")).toBe("x");
    expect(out.startsWith("#/inbox?")).toBe(true);
  });
  it("replaces an existing record", () => {
    const out = withRecord("#/contacts?record=contact:a", { kind: "ticket", id: "b" });
    expect(parseRecordParam(out)).toEqual({ kind: "ticket", id: "b" });
  });
  it("removes the record and the dangling ? when nothing else remains", () => {
    expect(withRecord("#/contacts?record=contact:a", null)).toBe("#/contacts");
    expect(withRecord("#/contacts?cf=Z&record=contact:a", null)).toBe("#/contacts?cf=Z");
  });
  it("falls back to the dashboard when there is no route", () => {
    expect(withRecord("", { kind: "booking", id: "b1" })).toBe("#/dashboard?record=booking%3Ab1");
    expect(withRecord("#", null)).toBe("#/dashboard");
  });
  it("round-trips unicode ids", () => {
    const out = withRecord("#/inbox", { kind: "contact", id: "جهة 1" });
    expect(parseRecordParam(out)).toEqual({ kind: "contact", id: "جهة 1" });
  });
});

describe("history helpers", () => {
  it("closeRecordHash drops only the record", () => {
    expect(closeRecordHash("#/inbox?f=A&record=contact:x")).toBe("#/inbox?f=A");
  });
  it("recordNavTarget pushes a new hash for a different record and null for the same one", () => {
    const a = "#/contacts?cf=Z&record=contact:a";
    expect(recordNavTarget(a, { kind: "contact", id: "a" })).toBeNull();
    const next = recordNavTarget(a, { kind: "ticket", id: "b" });
    expect(next).not.toBeNull();
    expect(parseRecordParam(next!)).toEqual({ kind: "ticket", id: "b" });
    expect(next).toContain("cf=Z");
  });
  it("walk: A -> B -> C then back x3 closes the sheet (stack model)", () => {
    // Model of browser history: hash assignment pushes, Back pops.
    const stack = ["#/contacts"];
    const push = (rec: { kind: "contact" | "ticket" | "conversation"; id: string }) => {
      const t = recordNavTarget(stack[stack.length - 1], rec);
      if (t) stack.push(t);
    };
    push({ kind: "contact", id: "A" });
    push({ kind: "ticket", id: "B" });
    push({ kind: "conversation", id: "C" });
    const cur = () => parseRecordParam(stack[stack.length - 1]);
    expect(cur()).toEqual({ kind: "conversation", id: "C" });
    stack.pop();
    expect(cur()).toEqual({ kind: "ticket", id: "B" });
    stack.pop();
    expect(cur()).toEqual({ kind: "contact", id: "A" });
    stack.pop();
    expect(cur()).toBeNull();
  });
});
