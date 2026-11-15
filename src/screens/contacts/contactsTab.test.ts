import { describe, expect, it } from "vitest";
import { audienceHash, contactsTabFromHash, withContactsTab } from "./contactsTab";

describe("contacts tab hash keeps the old groups link working", () => {
  it("opens the Audiences tab for ct=groups and ct=audiences", () => {
    expect(contactsTabFromHash("#/contacts?ct=groups")).toBe("audiences");
    expect(contactsTabFromHash("#/contacts?ct=audiences")).toBe("audiences");
  });

  it("reads the other tabs and falls back to contacts", () => {
    expect(contactsTabFromHash("#/contacts")).toBe("contacts");
    expect(contactsTabFromHash("#/contacts?ct=tags")).toBe("tags");
    expect(contactsTabFromHash("#/contacts?ct=fields")).toBe("fields");
    expect(contactsTabFromHash("#/contacts?ct=nope")).toBe("contacts");
    // an audience link alone opens its tab
    expect(contactsTabFromHash("#/contacts?aud=s1")).toBe("audiences");
  });

  it("writes the tab and drops the audience when leaving the Audiences tab", () => {
    expect(withContactsTab("#/contacts?cf=x", "audiences")).toBe("#/contacts?cf=x&ct=audiences");
    expect(withContactsTab("#/contacts?ct=groups", "audiences")).toBe("#/contacts?ct=audiences");
    expect(withContactsTab("#/contacts?ct=audiences&aud=s1", "tags")).toBe("#/contacts?ct=tags");
    expect(withContactsTab("#/contacts?ct=tags", "contacts")).toBe("#/contacts");
  });

  it("round-trips aud", () => {
    const h = audienceHash("s 1/ä");
    expect(h).toBe("#/contacts?ct=audiences&aud=s+1%2F%C3%A4");
    expect(contactsTabFromHash(h)).toBe("audiences");
    expect(new URLSearchParams(h.split("?")[1]).get("aud")).toBe("s 1/ä");
  });
});
