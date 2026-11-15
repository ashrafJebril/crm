import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261115140000_media_ai_details";
/** sha256 of applied files (LF, as committed). Applied in production: never edit them. */
const PINNED: Record<string, string> = {
  "20261114130000_contact_workspace_id_index": "af6730c4d81da99a945436a6ae8b08d571d23cef48d58ec026015c4842db50ef",
  "20261114140000_number_template_health": "24d05fd010ec625a3a0dfe1fde619d1364905fb2f3c7beb12266d4e833022dc0",
  "20261115120000_ctwa_attribution": "9aa652fdfe1bc8ab5311389f83d972dd014bef39f536c1dee2243502611eabec",
};

/**
 * What `prisma migrate diff --from-schema-datamodel <e8054d9 schema>
 * --to-schema-datamodel prisma/schema.prisma --script` printed for this change
 * (run 2026-11-14, no DB), whitespace-collapsed. The file must equal it apart
 * from `IF NOT EXISTS`.
 */
const PRISMA_DIFF = [
  'ALTER TABLE "Media" ADD COLUMN "alt" TEXT, ADD COLUMN "approvedForAgent" BOOLEAN NOT NULL DEFAULT false, ' +
    'ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[], ADD COLUMN "title" TEXT, ADD COLUMN "useWhen" TEXT;',
];

/** Hash as committed (LF), whatever the checkout's autocrlf did. */
const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-17 media details migration", () => {
  const sql = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"), "utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-17)", () => {
    const addCols = code.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(addCols).toHaveLength(5);
    for (const a of addCols) expect(a).toMatch(/^ADD COLUMN IF NOT EXISTS/i);

    expect(code).toMatch(/ALTER TABLE "Media" ADD COLUMN IF NOT EXISTS "alt" TEXT,/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "approvedForAgent" BOOLEAN NOT NULL DEFAULT false,/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "tags" TEXT\[\] DEFAULT ARRAY\[\]::TEXT\[\],/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "title" TEXT,/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "useWhen" TEXT;/);

    for (const bad of [
      /\bDROP\b/i,
      /\bUPDATE\b/i,
      /\bDELETE\b/i,
      /\bTRUNCATE\b/i,
      /ALTER COLUMN/i,
      /\bTYPE\b/i,
      /\bINSERT\b/i,
      /CREATE INDEX/i,
      /\bCONSTRAINT\b/i,
    ]) {
      expect(code).not.toMatch(bad);
    }

    // Ordered after every applied migration.
    expect(FOLDER.slice(0, 14) > "20261114140000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders[folders.length - 1]).toBe(FOLDER);
    expect(folders[folders.indexOf(FOLDER) - 1]).toBe("20261115120000_ctwa_attribution");
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
    expect(lfSha(readFileSync(join(MIGRATIONS, folder, "migration.sql")))).toBe(sha);
  });

  it("schema.prisma declares the five Media columns", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8");
    const media = schema.match(/model Media \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(media).toMatch(/\btitle\s+String\?/);
    expect(media).toMatch(/\balt\s+String\?/);
    expect(media).toMatch(/\btags\s+String\[\]\s+@default\(\[\]\)/);
    expect(media).toMatch(/\buseWhen\s+String\?/);
    expect(media).toMatch(/\bapprovedForAgent\s+Boolean\s+@default\(false\)/);
  });
});
