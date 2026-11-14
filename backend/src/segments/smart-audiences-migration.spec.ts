import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261115130000_smart_audiences";
/** sha256 of applied files (as committed). Applied in production: never edit them. */
const PINNED: Record<string, string> = {
  "20261114130000_contact_workspace_id_index": "af6730c4d81da99a945436a6ae8b08d571d23cef48d58ec026015c4842db50ef",
  "20261114140000_number_template_health": "24d05fd010ec625a3a0dfe1fde619d1364905fb2f3c7beb12266d4e833022dc0",
};

/**
 * `prisma migrate diff --from-schema-datamodel <d152351 schema> --to-schema-datamodel
 * prisma/schema.prisma --script` (Prisma 5.22.0, run 2026-11-14, no DB), whitespace-normalized.
 */
const PRISMA_DIFF = [
  'ALTER TABLE "Segment" ADD COLUMN "countedAt" TIMESTAMP(3), ADD COLUMN "memberCount" INTEGER, ADD COLUMN "rules" JSONB, ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;',
  'CREATE INDEX "Contact_workspaceId_createdAt_idx" ON "Contact"("workspaceId", "createdAt");',
];

describe("SP-16 smart audiences migration", () => {
  const sql = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"), "utf8");
  // Comments are ignored so prose never trips the keyword checks.
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-16)", () => {
    const addCols = code.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(addCols).toHaveLength(4);
    for (const a of addCols) expect(a).toMatch(/^ADD COLUMN IF NOT EXISTS/i);
    const creates = code.match(/\bCREATE\b[^;]*/gi) ?? [];
    expect(creates).toHaveLength(1);
    for (const c of creates) expect(c).toMatch(/^CREATE INDEX IF NOT EXISTS/i);

    // Exact names and shapes.
    expect(code).toContain('ADD COLUMN IF NOT EXISTS "rules" JSONB');
    expect(code).toContain('ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0');
    expect(code).toContain('ADD COLUMN IF NOT EXISTS "memberCount" INTEGER');
    expect(code).toContain('ADD COLUMN IF NOT EXISTS "countedAt" TIMESTAMP(3)');
    expect(code).toContain('CREATE INDEX IF NOT EXISTS "Contact_workspaceId_createdAt_idx" ON "Contact"("workspaceId", "createdAt");');

    // Only Segment is altered; no Message index (ruling 10).
    const alters = code.match(/ALTER TABLE "(\w+)"/g) ?? [];
    expect(alters).toEqual(['ALTER TABLE "Segment"']);
    expect(code).not.toMatch(/ON "Message"/);

    // Nothing destructive, rewriting or non-transactional.
    for (const bad of [/\bDROP\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /ALTER COLUMN/i, /\bTYPE\b/i, /CONCURRENTLY/i, /\bINSERT\b/i, /\bTRUNCATE\b/i]) {
      expect(code).not.toMatch(bad);
    }

    // Ordered after the applied SP-14 migration.
    expect(FOLDER.slice(0, 14) > "20261114140000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders.indexOf(FOLDER)).toBeGreaterThan(folders.indexOf("20261114140000_number_template_health"));
  });

  it("equals prisma migrate diff apart from IF NOT EXISTS", () => {
    const statements = code
      .replace(/IF NOT EXISTS /g, "")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((s) => `${s};`);
    expect(statements).toEqual(PRISMA_DIFF);
  });

  it.each(Object.entries(PINNED))("the applied %s file is unchanged (sha256)", (folder, sha) => {
    // Pinned as committed (LF); a checkout with core.autocrlf=true has CRLF on disk.
    const text = readFileSync(join(MIGRATIONS, folder, "migration.sql"), "utf8").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(sha);
  });

  it("schema.prisma declares the Segment columns and the Contact index", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8");
    const seg = schema.match(/model Segment \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(seg).toMatch(/\brules\s+Json\?/);
    expect(seg).toMatch(/\bversion\s+Int\s+@default\(0\)/);
    expect(seg).toMatch(/\bmemberCount\s+Int\?/);
    expect(seg).toMatch(/\bcountedAt\s+DateTime\?/);
    const contact = schema.match(/model Contact \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(contact).toContain("@@index([workspaceId, createdAt])");
  });
});
