import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  RESOURCES,
  hasPermission,
  isColumnAll,
  isRowAll,
  toggleCell,
  toggleColumn,
  toggleRow,
  type PermissionMatrix,
} from "./permissions";

describe("catalog", () => {
  it("matches the backend catalog", () => {
    expect(RESOURCES).toHaveLength(19);
    expect(RESOURCES).toContain("workflows");
    expect([...ACTIONS]).toEqual(["view", "create", "update", "delete", "manage"]);
  });
});

describe("matrix helpers", () => {
  it("toggleCell adds and removes without mutating", () => {
    const m: PermissionMatrix = { contacts: ["view"] };
    const a = toggleCell(m, "contacts", "update");
    expect(a.contacts).toEqual(["view", "update"]);
    expect(m.contacts).toEqual(["view"]);
    expect(toggleCell(a, "contacts", "view").contacts).toEqual(["update"]);
  });

  it("keeps actions in canonical order", () => {
    const m = toggleCell({ contacts: ["manage"] }, "contacts", "view");
    expect(m.contacts).toEqual(["view", "manage"]);
  });

  it("toggleRow grants all, then clears when already all", () => {
    const a = toggleRow({}, "tickets");
    expect(a.tickets).toEqual([...ACTIONS]);
    expect(isRowAll(a, "tickets")).toBe(true);
    expect(toggleRow(a, "tickets").tickets).toEqual([]);
  });

  it("toggleRow on a partial row grants all", () => {
    expect(toggleRow({ tickets: ["view"] }, "tickets").tickets).toEqual([...ACTIONS]);
  });

  it("toggleColumn sets all resources, then clears", () => {
    const a = toggleColumn({}, "view");
    expect(isColumnAll(a, "view")).toBe(true);
    expect(RESOURCES.every((r) => a[r]?.includes("view"))).toBe(true);
    const b = toggleColumn(a, "view");
    expect(isColumnAll(b, "view")).toBe(false);
    expect(RESOURCES.every((r) => !b[r]?.includes("view"))).toBe(true);
  });

  it("toggleColumn does not touch other actions", () => {
    const a = toggleColumn({ contacts: ["update"] }, "view");
    expect(a.contacts).toEqual(["view", "update"]);
  });

  it("isRowAll / isColumnAll are false for empty", () => {
    expect(isRowAll({}, "contacts")).toBe(false);
    expect(isColumnAll({}, "view")).toBe(false);
  });

  it("hasPermission parses resource.action", () => {
    const flat = new Set(["contacts.view"]);
    expect(hasPermission(flat, "contacts.view")).toBe(true);
    expect(hasPermission(flat, "contacts.delete")).toBe(false);
  });
});
