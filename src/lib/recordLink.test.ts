import { describe, expect, it } from "vitest";
import { recordHref } from "./recordLink";

describe("recordHref", () => {
  it("routes by kind with an open param", () => {
    expect(recordHref("conversation", "c1")).toBe("#/inbox?open=c1");
    expect(recordHref("ticket", "t1")).toBe("#/pipeline?open=t1");
    expect(recordHref("contact", "p1")).toBe("#/contacts?open=p1");
  });
  it("encodes ids", () => {
    expect(recordHref("conversation", "t_a b")).toBe("#/inbox?open=t_a%20b");
  });
  it("sends booking/campaign to their screens", () => {
    expect(recordHref("booking", "b1")).toBe("#/calendar");
    expect(recordHref("campaign", "m1")).toBe("#/campaigns");
  });
  it("returns null for missing or unknown kinds", () => {
    expect(recordHref(null, "x")).toBeNull();
    expect(recordHref("contact", null)).toBeNull();
    expect(recordHref("nope", "x")).toBeNull();
  });
});
