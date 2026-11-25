import { describe, expect, it } from "vitest";
import type { Permission } from "@/lib/permissions";
import { MODULES, NOTIFICATION_PREFS_HASH, visibleModules } from "./modules";

const WRITE = /\.(create|update|delete|manage)$/;
/** The system viewer role: every resource "view", except the hidden ones. */
const viewerCan = (p: Permission) => p.endsWith(".view");
const ownerCan = () => true;

describe("module settings hub", () => {
  it("module hub shows only permitted modules", () => {
    // A viewer sees no module whose every link needs a write permission.
    const viewer = visibleModules(viewerCan);
    for (const m of viewer) {
      expect({ m: m.key, writeOnly: m.links.every((l) => l.permission !== null && WRITE.test(l.permission)) }).toEqual({ m: m.key, writeOnly: false });
    }
    expect(viewer.map((m) => m.key)).toEqual(["notifications"]);

    // The owner sees every module and every link.
    const owner = visibleModules(ownerCan);
    expect(owner.map((m) => m.key)).toEqual(MODULES.map((m) => m.key));
    expect(owner.flatMap((m) => m.links).length).toBe(MODULES.flatMap((m) => m.links).length);

    // A member who manages bookings only: Bookings (both links) + Notifications.
    const booker = visibleModules((p) => p === "bookings.manage");
    expect(booker.map((m) => [m.key, m.links.map((l) => l.href)])).toEqual([
      ["bookings", ["#/calendar?tab=services", "#/calendar?tab=staff"]],
      ["notifications", [NOTIFICATION_PREFS_HASH]],
    ]);

    // Links carry the right hashes.
    const href = (key: string, label: string) => MODULES.find((m) => m.key === key)!.links.find((l) => l.label === label)!.href;
    expect(href("inbox", "Saved replies")).toBe("#/settings?tab=savedReplies");
    expect(href("contacts", "Custom fields")).toBe("#/contacts?ct=fields");
    expect(href("pipelines", "Pipelines")).toBe("#/settings?tab=pipelines");
    expect(href("ads", "Meta Ads connection")).toBe("#/ads?tab=connection");
    expect(href("agent", "Knowledge")).toBe("#/settings?tab=aiKnowledge");
    expect(href("team", "Members")).toBe("#/settings?tab=members");
    for (const l of MODULES.flatMap((m) => m.links)) expect(l.href.startsWith("#/")).toBe(true);
    // Bilingual copy everywhere.
    for (const m of MODULES) {
      expect(m.titleAr && m.descriptionAr).toBeTruthy();
      for (const l of m.links) expect(l.labelAr).toBeTruthy();
    }
  });
});
