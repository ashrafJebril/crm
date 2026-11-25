import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** SP-13 Task 2 (T1 review M4): the Contact (workspaceId, id) keyset index, in its own follow-up migration. */
const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261114130000_contact_workspace_id_index";
const PREVIOUS = "20261114120000_campaign_sending";

describe("contact keyset index migration", () => {
  it("is one additive, idempotent CREATE INDEX with the Prisma name, after the applied SP-13 migration", () => {
    const sql = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"), "utf8");
    const code = sql
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .trim();
    expect(code).toBe('CREATE INDEX IF NOT EXISTS "Contact_workspaceId_id_idx" ON "Contact"("workspaceId", "id");');
    expect(code).not.toMatch(/\b(DROP|UPDATE|DELETE|ALTER|TYPE)\b/i);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders[folders.indexOf(FOLDER) - 1]).toBe(PREVIOUS);
  });

  it("schema.prisma declares the index on Contact", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8");
    const model = schema.match(/model Contact \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(model).toContain("@@index([workspaceId, id])");
  });
});
