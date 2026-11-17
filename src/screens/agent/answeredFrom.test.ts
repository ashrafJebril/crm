import { describe, expect, it } from "vitest";
import { answeredFrom, safeHref } from "./answeredFrom";

describe("answered from", () => {
  it("shows 3 then +N, deduped, http(s) links only", () => {
    const out = answeredFrom([
      { sourceId: "a", title: "Hours", url: "https://salon.example/hours" },
      { sourceId: "a", title: "Hours again" },
      { sourceId: "b", title: "Prices", url: "javascript:alert(1)" },
      { sourceId: "c", title: "FAQ" },
      { sourceId: "d", title: "Menu", url: "http://salon.example/menu" },
      { sourceId: "e", title: "" },
    ]);
    expect(out.visible).toEqual([
      { sourceId: "a", title: "Hours", href: "https://salon.example/hours" },
      { sourceId: "b", title: "Prices", href: null },
      { sourceId: "c", title: "FAQ", href: null },
    ]);
    expect(out.more).toBe(2);
    expect(answeredFrom(undefined)).toEqual({ visible: [], more: 0 });
  });

  it("safeHref accepts only http and https", () => {
    expect(safeHref("https://a.example/x")).toBe("https://a.example/x");
    for (const bad of ["data:text/html,x", "javascript:x", "ftp://a.example", "not a url", undefined]) expect(safeHref(bad)).toBeNull();
  });
});
