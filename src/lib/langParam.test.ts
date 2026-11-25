import { describe, expect, it } from "vitest";
import { firstRunLang, readLangParam, routeHash, stripUnknownLang, withLang } from "./langParam";

describe("lang param read, kept on navigation and ignored when unknown", () => {
  it("reads ar/en and ignores anything else", () => {
    expect(readLangParam("#/inbox?lang=ar")).toBe("ar");
    expect(readLangParam("#/inbox?id=1&lang=en")).toBe("en");
    expect(readLangParam("#/inbox?lang=fr")).toBeNull();
    expect(readLangParam("#/inbox")).toBeNull();
    expect(readLangParam("")).toBeNull();
    expect(readLangParam(null)).toBeNull();
  });

  it("withLang keeps the other params", () => {
    expect(withLang("#/contacts?q=x", "ar")).toBe("#/contacts?q=x&lang=ar");
    expect(withLang("#/contacts?lang=en&q=x", "ar")).toBe("#/contacts?lang=ar&q=x");
    expect(withLang("#/inbox", "en")).toBe("#/inbox?lang=en");
    expect(stripUnknownLang("#/inbox?id=1&lang=fr")).toBe("#/inbox?id=1");
    expect(stripUnknownLang("#/inbox?lang=ar")).toBe("#/inbox?lang=ar");
  });

  it("a setRoute-style hash builder keeps lang", () => {
    expect(routeHash("contacts", "#/inbox?id=1&lang=ar")).toBe("#/contacts?lang=ar");
    expect(routeHash("contacts", "#/inbox?id=1")).toBe("#/contacts");
    expect(routeHash("contacts", "#/inbox?lang=fr")).toBe("#/contacts");
    // Re-selecting the current route keeps its query.
    expect(routeHash("inbox", "#/inbox?filter=open&lang=en")).toBe("#/inbox?filter=open&lang=en");
  });
});

describe("first-run language follows workspace lang", () => {
  it("no stored choice → the workspace lang; a stored choice wins", () => {
    expect(firstRunLang(null, "ar")).toBe("ar");
    expect(firstRunLang({ lang: "en", langChosen: false }, "ar")).toBe("ar");
    expect(firstRunLang({ lang: "en", langChosen: true }, "ar")).toBeNull();
    // A record from before langChosen existed counts as a choice.
    expect(firstRunLang({ lang: "en" }, "ar")).toBeNull();
    expect(firstRunLang(null, "fr")).toBeNull();
    expect(firstRunLang(null, undefined)).toBeNull();
  });
});
