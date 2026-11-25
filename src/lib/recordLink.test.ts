import { describe, expect, it } from "vitest";
import { recordHref } from "./recordLink";
import { parseRecordParam } from "./recordParam";

describe("recordHref", () => {
  it("opens the sheet on the current route for all five kinds", () => {
    for (const kind of ["conversation", "ticket", "contact", "booking", "campaign"]) {
      const href = recordHref(kind, "x1", "#/pipeline")!;
      expect(href.startsWith("#/pipeline?")).toBe(true);
      expect(parseRecordParam(href)).toEqual({ kind, id: "x1" });
    }
  });
  it("preserves the current filters", () => {
    const href = recordHref("contact", "p1", "#/inbox?f=AAA&cf=BBB")!;
    expect(href).toContain("f=AAA");
    expect(href).toContain("cf=BBB");
    expect(parseRecordParam(href)).toEqual({ kind: "contact", id: "p1" });
  });
  it("replaces a record that is already open", () => {
    expect(parseRecordParam(recordHref("ticket", "t9", "#/contacts?record=contact:a")!)).toEqual({ kind: "ticket", id: "t9" });
  });
  it("sends opaque thread ids to the inbox deep link", () => {
    expect(recordHref("conversation", "t_a b", "#/contacts?cf=Z")).toBe("#/inbox?open=t_a%20b");
    expect(recordHref("conversation", "ig:123", "#/contacts")).toBe("#/inbox?open=ig%3A123");
  });
  it("returns null for missing or unknown kinds", () => {
    expect(recordHref(null, "x", "#/inbox")).toBeNull();
    expect(recordHref("contact", null, "#/inbox")).toBeNull();
    expect(recordHref("nope", "x", "#/inbox")).toBeNull();
  });
});
