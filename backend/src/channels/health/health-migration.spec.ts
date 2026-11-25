import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "..", "prisma", "migrations");
const FOLDER = "20261114140000_number_template_health";
/** sha256 of the applied files (LF, as committed). Applied in production: never edit them. */
const PINNED: Record<string, string> = {
  "20261114120000_campaign_sending": "d4386bf26cade581a040cf7fa9f4df2d0079cf6b2df5b73190ce3826de111795",
  "20261114130000_contact_workspace_id_index": "af6730c4d81da99a945436a6ae8b08d571d23cef48d58ec026015c4842db50ef",
};

/**
 * What `prisma migrate diff --from-schema-datamodel <913fbbd schema>
 * --to-schema-datamodel prisma/schema.prisma --script` printed for this change
 * (run 2026-11-09, no DB), whitespace-collapsed. The file must equal it apart
 * from `IF NOT EXISTS`.
 */
const PRISMA_DIFF = [
  'ALTER TABLE "Template" ADD COLUMN "quality" TEXT;',
  'ALTER TABLE "Channel" ADD COLUMN "healthAttemptedAt" TIMESTAMP(3), ADD COLUMN "healthCheckedAt" TIMESTAMP(3);',
  'CREATE INDEX "Channel_kind_healthAttemptedAt_idx" ON "Channel"("kind", "healthAttemptedAt");',
];

describe("SP-14 number and template health migration", () => {
  const sql = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"), "utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-14)", () => {
    const addCols = code.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(addCols).toHaveLength(3);
    for (const a of addCols) expect(a).toMatch(/^ADD COLUMN IF NOT EXISTS/i);
    const creates = code.match(/\bCREATE\b[^;]*/gi) ?? [];
    expect(creates).toHaveLength(1);
    for (const c of creates) expect(c).toMatch(/^CREATE INDEX IF NOT EXISTS/i);

    // Exact names and definitions.
    expect(code).toMatch(/ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "quality" TEXT;/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "healthCheckedAt" TIMESTAMP\(3\)/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "healthAttemptedAt" TIMESTAMP\(3\)/);
    expect(code).toMatch(
      /CREATE INDEX IF NOT EXISTS "Channel_kind_healthAttemptedAt_idx" ON "Channel"\("kind", "healthAttemptedAt"\);/,
    );
    // Nullable only: no NOT NULL, no default, nothing destructive or rewriting.
    for (const bad of [
      /\bDROP\b/i,
      /\bUPDATE\b/i,
      /\bDELETE\b/i,
      /\bTRUNCATE\b/i,
      /ALTER COLUMN/i,
      /\bTYPE\b/i,
      /\bINSERT\b/i,
      /NOT NULL/i,
      /\bCONSTRAINT\b/i,
    ]) {
      expect(code).not.toMatch(bad);
    }

    // Ordered after the last applied migration.
    expect(FOLDER.slice(0, 14) > "20261114130000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders[folders.indexOf(FOLDER) - 1]).toBe("20261114130000_contact_workspace_id_index");
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
    const bytes = readFileSync(join(MIGRATIONS, folder, "migration.sql"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
  });

  it("schema.prisma declares the columns and the index", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8");
    const channel = schema.match(/model Channel \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(channel).toMatch(/healthCheckedAt\s+DateTime\?/);
    expect(channel).toMatch(/healthAttemptedAt\s+DateTime\?/);
    expect(channel).toContain("@@index([kind, healthAttemptedAt])");
    const template = schema.match(/model Template \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(template).toMatch(/quality\s+String\?/);
  });
});
