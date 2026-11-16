import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261116140000_insights_home";
/** sha256 of earlier files (LF, as committed). Never edit them. SP-09's is
 *  applied; SP-10's is written and reviewed (unapplied when this was written). */
const PINNED: Record<string, string> = {
  "20261116120000_support_tickets": "555000f79d7d764bf69429a0bd56b52b4893802e56a5e4cc01da949ef7b6e22c",
  "20261116130000_bookings_catalog": "913dad261ab4f163019f2d3c3c1b8a8bdf98ca08e233bcad489aa373aef08875",
};

/**
 * What `prisma migrate diff --from-schema-datamodel <d8a6a76 schema>
 * --to-schema-datamodel prisma/schema.prisma --script` yields for this change
 * (Prisma 5.22: one ALTER TABLE per table, tables and columns in name order),
 * whitespace-collapsed. Written by hand: the task ran no `prisma migrate`
 * command at all. The file must equal it apart from `IF NOT EXISTS`, the
 * statement order and the lock_timeout line.
 */
const PRISMA_DIFF = [
  'ALTER TABLE "Message" ADD COLUMN "sentById" TEXT;',
  'ALTER TABLE "WorkspaceMember" ADD COLUMN "homeDay1DismissedAt" TIMESTAMP(3), ADD COLUMN "homeSeenAt" TIMESTAMP(3);',
];

/** Hash as committed (LF), whatever the checkout's autocrlf did. */
const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-11 insights and home migration", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const sql = raw.toString("utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const statements = code
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  it("migration is additive, idempotent and Prisma-named (SP-11)", () => {
    // Exactly three columns, each IF NOT EXISTS, nullable, no default.
    const addCols = code.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(addCols.map((a) => a.replace(/\s+/g, " ").trim())).toEqual([
      'ADD COLUMN IF NOT EXISTS "homeSeenAt" TIMESTAMP(3)',
      'ADD COLUMN IF NOT EXISTS "homeDay1DismissedAt" TIMESTAMP(3)',
      'ADD COLUMN IF NOT EXISTS "sentById" TEXT',
    ]);
    expect(code).not.toMatch(/NOT NULL/i);
    expect(code).not.toMatch(/DEFAULT/i);

    // Two ALTER TABLEs and the lock_timeout; nothing else.
    expect(statements).toEqual([
      "SET lock_timeout = '5s'",
      'ALTER TABLE "WorkspaceMember" ADD COLUMN IF NOT EXISTS "homeSeenAt" TIMESTAMP(3), ADD COLUMN IF NOT EXISTS "homeDay1DismissedAt" TIMESTAMP(3)',
      'ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "sentById" TEXT',
    ]);
    for (const bad of [
      /\bINDEX\b/i,
      /FOREIGN KEY/i,
      /REFERENCES/i,
      /CONSTRAINT/i,
      /\bUPDATE\b/i,
      /\bDELETE\b/i,
      /\bINSERT\b/i,
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /ALTER COLUMN/i,
      /\bTYPE\b/i,
      /\bTRIGGER\b/i,
      /CREATE /i,
    ]) {
      expect({ bad: String(bad), hit: bad.test(code) }).toEqual({ bad: String(bad), hit: false });
    }

    // Ordered after SP-10's migration, which is the latest folder before it.
    expect(FOLDER.slice(0, 14) > "20261116130000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders[folders.indexOf(FOLDER) - 1]).toBe("20261116130000_bookings_catalog");

    // LF only (Prisma checksums the exact bytes; .gitattributes enforces it on commit).
    expect(raw.includes(Buffer.from("\r\n"))).toBe(false);
  });

  it("equals prisma migrate diff apart from IF NOT EXISTS, statement order and lock_timeout", () => {
    const sortCols = (s: string) => {
      const m = /^(ALTER TABLE "[^"]+") (.*);?$/.exec(s.replace(/;$/, ""));
      if (!m) return s;
      return `${m[1]} ${m[2].split(/, (?=ADD COLUMN)/).sort().join(", ")};`;
    };
    const ours = statements
      .filter((s) => !s.startsWith("SET "))
      .map((s) => sortCols(s.replace(/IF NOT EXISTS /g, "")))
      .sort();
    expect(ours).toEqual(PRISMA_DIFF.map(sortCols).sort());
  });

  it("sets lock_timeout first", () => {
    expect(statements[0]).toBe("SET lock_timeout = '5s'");
    expect((code.match(/^SET /gm) ?? []).length).toBe(1);
  });

  it.each(Object.entries(PINNED))("the earlier %s file is unchanged (sha256)", (folder, sha) => {
    expect(lfSha(readFileSync(join(MIGRATIONS, folder, "migration.sql")))).toBe(sha);
  });

  it("schema.prisma declares the three SP-11 columns, with no relation or index on sentById", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
    const block = (name: string) => schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
    const member = block("WorkspaceMember");
    expect(member).toMatch(/\n\s+homeSeenAt\s+DateTime\?\n/);
    expect(member).toMatch(/\n\s+homeDay1DismissedAt\s+DateTime\?\n/);
    const message = block("Message");
    expect(message).toMatch(/\n\s+sentById\s+String\?\n/);
    expect(message).not.toMatch(/sentBy\s+User/);
    expect(message).not.toMatch(/@@index\(\[[^\]]*sentById/);
  });
});
