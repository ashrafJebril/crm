import { describe, expect, it } from "vitest";
import { firstNameOf, greeting, homeSubtitle } from "./greeting";

const RIYADH = "Asia/Riyadh";
// Riyadh is UTC+3: 06:00Z = 09:00 local, 10:00Z = 13:00 local, 16:00Z = 19:00 local.
const at = (iso: string) => new Date(iso);

describe("greeting", () => {
  it("greeting uses the member name and workspace timezone", () => {
    expect(greeting(at("2026-11-10T06:00:00Z"), RIYADH, "Sami", "en")).toBe("Good morning, Sami");
    expect(greeting(at("2026-11-10T10:00:00Z"), RIYADH, "Sami", "en")).toBe("Good afternoon, Sami");
    expect(greeting(at("2026-11-10T16:00:00Z"), RIYADH, "Sami", "en")).toBe("Good evening, Sami");
    // Workspace-local, not UTC: 02:30Z is 05:30 in Riyadh (morning) but 02:30 in UTC (evening).
    expect(greeting(at("2026-11-10T02:30:00Z"), RIYADH, "Sami", "en")).toBe("Good morning, Sami");
    expect(greeting(at("2026-11-10T02:30:00Z"), "UTC", "Sami", "en")).toBe("Good evening, Sami");
    // Edges: 05:00 morning, 12:00 afternoon, 17:00 evening (local).
    expect(greeting(at("2026-11-10T02:00:00Z"), RIYADH, "Sami", "en")).toBe("Good morning, Sami");
    expect(greeting(at("2026-11-10T09:00:00Z"), RIYADH, "Sami", "en")).toBe("Good afternoon, Sami");
    expect(greeting(at("2026-11-10T14:00:00Z"), RIYADH, "Sami", "en")).toBe("Good evening, Sami");
    // Arabic copy.
    expect(greeting(at("2026-11-10T06:00:00Z"), RIYADH, "سامي", "ar")).toBe("صباح الخير يا سامي");
    expect(greeting(at("2026-11-10T10:00:00Z"), RIYADH, "سامي", "ar")).toBe("نهارك سعيد يا سامي");
    expect(greeting(at("2026-11-10T16:00:00Z"), RIYADH, "سامي", "ar")).toBe("مساء الخير يا سامي");
    // No name: "Welcome back".
    expect(greeting(at("2026-11-10T06:00:00Z"), RIYADH, null, "en")).toBe("Welcome back");
    expect(greeting(at("2026-11-10T06:00:00Z"), RIYADH, "  ", "ar")).toBe("أهلاً بعودتك");
    // An invalid zone falls back to Asia/Riyadh.
    expect(greeting(at("2026-11-10T06:00:00Z"), "Mars/Base", "Sami", "en")).toBe("Good morning, Sami");
    // The first word of the member's name; never a hardcoded one.
    expect(firstNameOf("Sami Haddad")).toBe("Sami");
    expect(firstNameOf("  ")).toBeNull();
    expect(firstNameOf(undefined)).toBeNull();
    for (const lang of ["en", "ar"] as const) {
      for (const h of [0, 6, 10, 16, 22]) {
        const g = greeting(new Date(Date.UTC(2026, 10, 10, h)), RIYADH, firstNameOf("Sami Haddad"), lang);
        expect(g).not.toMatch(/Yara|يارا|Samemha/);
      }
    }
  });

  it("the subtitle names the workspace", () => {
    expect(homeSubtitle("Acme", "en")).toBe("Here's how Acme is doing today");
    expect(homeSubtitle("Acme", "ar")).toBe("إليك ما يحدث في Acme اليوم");
    expect(homeSubtitle(null, "en")).toBe("Here's how your workspace is doing today");
    expect(homeSubtitle(null, "ar")).toBe("إليك ما يحدث في مساحة عملك اليوم");
  });
});
