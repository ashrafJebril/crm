import { describe, expect, it } from "vitest";
import { arabicServerMessage, roleOptionsFromTeam, changedRoleFields, type RoleDraft } from "./roleErrors";

describe("arabicServerMessage", () => {
  const cases = [
    "Cannot grant permissions you don't have",
    "Cannot remove or demote the last owner",
    "Only an owner can change an owner",
    "Send role or roleId, not both",
    "Switch to this workspace first",
    "You can't change a member with more access than you",
    "Only the author can change this note",
    "Another change happened at the same time — try again",
    "Another change happened at the same time - try again",
  ];
  it.each(cases)("maps %s to Arabic", (m) => {
    const ar = arabicServerMessage(m);
    expect(ar).not.toBeNull();
    expect(/[؀-ۿ]/.test(ar!)).toBe(true);
  });
  it("maps role-in-use variants", () => {
    expect(arabicServerMessage("Role is assigned to 3 members")).toMatch(/[؀-ۿ]/);
  });
  it("returns null for unknown messages", () => {
    expect(arabicServerMessage("Something else")).toBeNull();
  });
});

describe("changedRoleFields", () => {
  const role: RoleDraft = {
    name: "A",
    nameAr: "ا",
    permissions: { contacts: ["view"] },
    conversationVisibility: "all",
  };
  it("rename-only sends only names", () => {
    const out = changedRoleFields(role, { ...role, name: "B" });
    expect(out).toEqual({ name: "B" });
  });
  it("sends permissions only when changed", () => {
    const out = changedRoleFields(role, { ...role, permissions: { contacts: ["view", "create"] } });
    expect(Object.keys(out)).toEqual(["permissions"]);
  });
  it("sends visibility only when changed", () => {
    expect(changedRoleFields(role, { ...role, conversationVisibility: "assigned" })).toEqual({
      conversationVisibility: "assigned",
    });
  });
  it("empty when unchanged", () => {
    expect(changedRoleFields(role, { ...role })).toEqual({});
  });
});

describe("roleOptionsFromTeam", () => {
  it("dedupes by roleId and skips null", () => {
    const out = roleOptionsFromTeam([
      { roleId: "1", roleName: "Admin", roleNameAr: "مدير" },
      { roleId: "1", roleName: "Admin", roleNameAr: "مدير" },
      { roleId: null, roleName: "x", roleNameAr: "x" },
      { roleId: "2", roleName: "Agent", roleNameAr: "موظف" },
    ]);
    expect(out.map((r) => r.id)).toEqual(["1", "2"]);
  });
});
