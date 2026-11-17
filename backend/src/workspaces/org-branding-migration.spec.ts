import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261118150000_org_branding";
/** sha256 of the predecessors present in this base (LF, as committed). Never edit them. */
const PINNED: Record<string, string> = {
  // SP-22.
  "20261117160000_skills_gallery": "28374cfb0b9d1f7c9658e59253484ec2510ac963833c62ba78d2087b8d39d4f2",
  // SP-26.
  "20261118120000_members_security": "f0a7a531550ffdf36bdfb94d24fc22affdd20d3094ec303c01e44cd469635767",
  // SP-27.
  "20261118130000_api_keys_webhooks": "eeec6199af34d73757aaf08a0aabe304b014a0429eeca57955c2d8ecc2f777d5",
};
/** SP-28's migration (not in this base yet): this one must sort after it. */
const SP28 = "20261118140000_billing_portal";

/**
 * What `prisma migrate diff --from-schema-datamodel <cd7701c schema>
 * --to-schema-datamodel prisma/schema.prisma --script` printed (Prisma 5.22.0,
 * 2026-11-18, no DB), whitespace-collapsed, comments dropped. The file must
 * equal it apart from `IF NOT EXISTS`, the duplicate_object wrapper and the
 * lock_timeout.
 */
const PRISMA_DIFF = [
  'ALTER TABLE "Workspace" ADD COLUMN "brandColor" TEXT, ADD COLUMN "logoMediaId" TEXT;',
  'ALTER TABLE "Media" ADD COLUMN "purpose" TEXT;',
  'ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_logoMediaId_fkey" FOREIGN KEY ("logoMediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
];

const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-29 org branding migration", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const sql = raw.toString("utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-29)", () => {
    // Every added column is guarded and nullable (no NOT NULL, no default).
    const adds = code.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(adds).toHaveLength(3);
    for (const a of adds) expect(a).toMatch(/^ADD COLUMN IF NOT EXISTS "(brandColor|logoMediaId|purpose)" TEXT\s*$/);
    // The FK in a duplicate_object block, with SET NULL.
    expect(code).toMatch(
      /DO \$\$ BEGIN\s+ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_logoMediaId_fkey" FOREIGN KEY \("logoMediaId"\) REFERENCES "Media"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE;\s+EXCEPTION WHEN duplicate_object THEN NULL;\s+END \$\$;/,
    );
    expect(code).toContain("SET lock_timeout = '5s';");
    // No destructive or rewriting statement, no index (Prisma emits none for a plain FK), no other table.
    // ("ON DELETE SET NULL" / "ON UPDATE CASCADE" are the FK's actions, not statements.)
    expect(code.replace(/ON (DELETE|UPDATE) (SET NULL|CASCADE)/g, "")).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME|ALTER COLUMN|SET NOT NULL|SET DATA TYPE|CREATE (UNIQUE )?INDEX|CREATE TABLE)\b/i);
    expect([...code.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["Media", "Workspace", "Workspace"]);
    expect(code).not.toMatch(/"Ads[A-Za-z]*"/);
  });

  it("equals the recorded prisma migrate diff apart from the guards", () => {
    const strip = code
      .replace(/SET lock_timeout = '5s';/, "")
      .replace(/DO \$\$ BEGIN\s+/g, "")
      .replace(/\s+EXCEPTION WHEN duplicate_object THEN NULL;\s+END \$\$;/g, "")
      .replace(/ IF NOT EXISTS/g, "")
      .replace(/\s+/g, " ")
      .trim();
    expect(strip).toBe(PRISMA_DIFF.join(" "));
  });

  it("sorts after its pinned predecessors and SP-28's; predecessors unchanged; LF", () => {
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    for (const [name, sha] of Object.entries(PINNED)) {
      expect(folders).toContain(name);
      expect({ name, sha: lfSha(readFileSync(join(MIGRATIONS, name, "migration.sql"))) }).toEqual({ name, sha });
      expect(FOLDER > name).toBe(true);
    }
    // Ordering, not adjacency: SP-28's folder may or may not be present in this base.
    expect(FOLDER > SP28).toBe(true);
    expect(folders).toContain(FOLDER);
    expect(raw.includes(Buffer.from("\r\n"))).toBe(false);
  });
});
