import { describe, expect, it } from "vitest";
import { openParamForRoute } from "./useOpenParam";

describe("openParamForRoute", () => {
  it("returns the id only for the matching route", () => {
    expect(openParamForRoute("#/inbox?open=c1", "inbox")).toBe("c1");
    expect(openParamForRoute("#/pipeline?open=t1", "inbox")).toBeNull();
    expect(openParamForRoute("#/contacts?open=p1&cf=x", "contacts")).toBe("p1");
  });
  it("returns null without an open param or route", () => {
    expect(openParamForRoute("#/inbox", "inbox")).toBeNull();
    expect(openParamForRoute("", "inbox")).toBeNull();
  });
  it("does not match route prefixes", () => {
    expect(openParamForRoute("#/inbox2?open=x", "inbox")).toBeNull();
  });
});
