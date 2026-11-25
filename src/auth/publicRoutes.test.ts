import { describe, expect, it } from "vitest";
import {
  LEGACY_REMEMBER_PW_KEY,
  langParam,
  parsePublicFragment,
  parsePublicLocation,
  removeRememberedPassword,
  safeNext,
  scrubbedUrl,
} from "./publicRoutes";

const T = "A".repeat(20) + "b_-".repeat(7) + "Z".repeat(2); // 43 chars

describe("public routes", () => {
  it("public fragment parsing and safe next", () => {
    expect(T).toHaveLength(43);
    expect(parsePublicFragment(`#/accept-invite?token=${T}`)).toEqual({ kind: "accept", token: T });
    expect(parsePublicFragment(`#/reset-password?token=${T}`)).toEqual({ kind: "reset", token: T });
    expect(parsePublicFragment("#/activate?ws=acme&next=inbox")).toEqual({ kind: "activate", slug: "acme", next: "inbox" });
    expect(parsePublicFragment("#/forgot-password")).toEqual({ kind: "forgot" });
    for (const bad of ["//evil.com", "https://evil.com", "https:evil", "%2F%2Fevil.com", "nope", "javascript:alert(1)", "%E0%A4%A"]) {
      expect({ bad, next: safeNext(bad) }).toEqual({ bad, next: "dashboard" });
      expect(parsePublicFragment(`#/activate?ws=acme&next=${encodeURIComponent(bad)}`)).toMatchObject({ next: "dashboard" });
    }
    expect(safeNext("%23%2Fteam")).toBe("team");
    // A missing or malformed token → null.
    expect(parsePublicFragment("#/accept-invite")).toBeNull();
    expect(parsePublicFragment("#/accept-invite?token=short")).toBeNull();
    expect(parsePublicFragment("#/reset-password?token=")).toBeNull();
    expect(parsePublicFragment("#/activate?ws=Bad Slug")).toBeNull();
    expect(parsePublicFragment("#/inbox")).toBeNull();
    expect(parsePublicFragment("")).toBeNull();
  });

  it("parses the emailed path links and scrubs the token from the URL", () => {
    expect(parsePublicLocation({ pathname: "/invite", search: `?token=${T}&lang=ar`, hash: "" })).toEqual({ kind: "accept", token: T });
    expect(parsePublicLocation({ pathname: "/reset/", search: `?token=${T}`, hash: "" })).toEqual({ kind: "reset", token: T });
    expect(parsePublicLocation({ pathname: "/invite", search: "?token=x", hash: "" })).toBeNull();
    expect(parsePublicLocation({ pathname: "/", search: "", hash: `#/accept-invite?token=${T}` })).toEqual({ kind: "accept", token: T });
    for (const page of [{ kind: "accept", token: T } as const, { kind: "reset", token: T } as const]) {
      const url = scrubbedUrl(page, "ar");
      expect(url).not.toContain(T);
      expect(url).toContain("lang=ar");
    }
    expect(langParam("?token=x&lang=en")).toBe("en");
    expect(langParam("?lang=fr")).toBeNull();
  });

  it("removes a remembered plaintext password from this browser", () => {
    const store = new Map<string, string>([[LEGACY_REMEMBER_PW_KEY, "hunter2"], ["aram.remember.email", "a@x.test"]]);
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
    };
    expect(removeRememberedPassword(storage)).toBe(true);
    expect(store.has(LEGACY_REMEMBER_PW_KEY)).toBe(false);
    expect(store.get("aram.remember.email")).toBe("a@x.test"); // the email may stay
    expect(removeRememberedPassword(storage)).toBe(false);
    expect(removeRememberedPassword(null)).toBe(false);
    const throwing = { getItem: () => { throw new Error("blocked"); }, removeItem: () => undefined };
    expect(removeRememberedPassword(throwing)).toBe(false);
  });
});
