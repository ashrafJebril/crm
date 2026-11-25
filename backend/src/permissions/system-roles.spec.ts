import * as fs from "fs";
import * as path from "path";
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS } from "./system-roles";
import { ACTIONS, RESOURCES, validatePermissions } from "./catalog";

const MIGRATION = path.resolve(
  __dirname,
  "../../prisma/migrations/20261109180000_roles/migration.sql",
);

describe("system roles", () => {
  it("system roles in migration equal SYSTEM_ROLES", () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    const re = /\('(owner|admin|agent|viewer)', '([^']*)', '([^']*)', '(\{[^']*\})', '(all|assigned)'\)/g;
    const found: Record<string, unknown> = {};
    for (const m of sql.matchAll(re)) {
      found[m[1]] = {
        name: m[2],
        nameAr: m[3],
        permissions: JSON.parse(m[4]),
        conversationVisibility: m[5],
      };
    }
    expect(found).toEqual(SYSTEM_ROLES);
  });

  it("migration VALUES rows are well-formed 5-column tuples", () => {
    const sql = fs.readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n");
    const head = "CROSS JOIN (VALUES\n";
    const start = sql.indexOf(head);
    const end = sql.indexOf("\n) AS r(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = sql.slice(start + head.length, end);
    // A doubled paren makes each row a single record column (Postgres error).
    expect(block).not.toContain("((");
    expect(block).not.toContain("))");
    const rows = block.split("\n");
    expect(rows).toHaveLength(4);
    rows.forEach((row, i) => {
      const comma = i < rows.length - 1 ? "," : "";
      expect(row).toMatch(
        new RegExp(String.raw`^\s*\('(owner|admin|agent|viewer)', '[^']*', '[^']*', '\{[^']*\}', '(all|assigned)'\)${comma}$`),
      );
    });
    expect(sql).toContain(') AS r("key", "name", "nameAr", "permissions", "conversationVisibility")');
  });

  it("every system matrix passes validation unchanged", () => {
    for (const k of SYSTEM_ROLE_KEYS) {
      expect(validatePermissions(SYSTEM_ROLES[k].permissions)).toEqual(SYSTEM_ROLES[k].permissions);
    }
  });

  const has = (k: keyof typeof SYSTEM_ROLES, res: string, act: string) =>
    (SYSTEM_ROLES[k].permissions[res as keyof typeof SYSTEM_ROLES.owner.permissions] ?? []).includes(act as never);

  it("owner: every action on every resource", () => {
    for (const r of RESOURCES) for (const a of ACTIONS) expect(has("owner", r, a)).toBe(true);
  });

  it("admin: everything except billing.manage and roles.manage", () => {
    for (const r of RESOURCES)
      for (const a of ACTIONS)
        expect([`${r}.${a}`, has("admin", r, a)]).toEqual([
          `${r}.${a}`,
          !(a === "manage" && (r === "billing" || r === "roles")),
        ]);
  });

  it("agent: matrix from Global Constraints", () => {
    const vcu = ["conversations", "contacts", "tickets", "bookings", "audiences", "campaigns", "templates", "workflows"];
    const v = ["pipelines", "knowledge", "agent", "channels", "reports", "members"];
    const vcud = ["templates", "audiences", "bookings", "workflows"]; // final-review ruling: + delete
    for (const r of RESOURCES)
      for (const a of ACTIONS) {
        const want =
          (vcu.includes(r) && ["view", "create", "update"].includes(a)) ||
          (vcud.includes(r) && a === "delete") ||
          (v.includes(r) && a === "view");
        expect([`${r}.${a}`, has("agent", r, a)]).toEqual([`${r}.${a}`, want]);
      }
    expect(has("agent", "contacts", "delete")).toBe(false);
    expect(has("agent", "tickets", "delete")).toBe(false);
    expect(has("agent", "campaigns", "delete")).toBe(false);
  });

  it("viewer: view on everything except billing, api_keys, roles", () => {
    for (const r of RESOURCES)
      for (const a of ACTIONS)
        expect([`${r}.${a}`, has("viewer", r, a)]).toEqual([
          `${r}.${a}`,
          a === "view" && !["billing", "api_keys", "roles"].includes(r),
        ]);
  });

  it("every system role sees all conversations", () => {
    for (const k of SYSTEM_ROLE_KEYS) expect(SYSTEM_ROLES[k].conversationVisibility).toBe("all");
  });
});
