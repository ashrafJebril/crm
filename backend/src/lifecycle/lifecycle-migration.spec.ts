import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261117150000_lifecycle_messages";
/** sha256 of earlier files (LF, as committed). Never edit them. SP-09's and
 *  SP-10's are applied; SP-11's and SP-21's were written and reviewed (not
 *  yet applied when this was written). */
const PINNED: Record<string, string> = {
  "20261116120000_support_tickets": "555000f79d7d764bf69429a0bd56b52b4893802e56a5e4cc01da949ef7b6e22c",
  "20261116130000_bookings_catalog": "913dad261ab4f163019f2d3c3c1b8a8bdf98ca08e233bcad489aa373aef08875",
  "20261116140000_insights_home": "a203771a9711c07a15bd26ab41635af9e2177ac0cdb767b434242d9d36ba9013",
  "20261117120000_knowledge_upgrade": "463dcac144c1c369fd40479007ec824a21e766c34238d19ab2705a3db6c4a1db",
};

/**
 * What `prisma migrate diff --from-schema-datamodel <962e6e1 schema>
 * --to-schema-datamodel prisma/schema.prisma --script` yields for this change
 * (Prisma 5.22), whitespace-collapsed. Written by hand: no `prisma migrate`
 * command was run (ruling 14). The file must equal it apart from
 * `IF NOT EXISTS`, the duplicate_object wrappers, the lock_timeout line and
 * statement order.
 */
const PRISMA_DIFF = [
  'ALTER TABLE "Workflow" ADD COLUMN "systemKey" TEXT;',
  'CREATE TABLE "LifecycleDelivery" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "workflowId" TEXT NOT NULL, ' +
    '"entityKind" TEXT NOT NULL, "entityId" TEXT NOT NULL, "occurrenceKey" TEXT NOT NULL, "runId" TEXT, ' +
    '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "LifecycleDelivery_pkey" PRIMARY KEY ("id") );',
  'CREATE INDEX "LifecycleDelivery_workspaceId_createdAt_idx" ON "LifecycleDelivery"("workspaceId", "createdAt");',
  'CREATE UNIQUE INDEX "LifecycleDelivery_workflowId_entityId_occurrenceKey_key" ON "LifecycleDelivery"("workflowId", "entityId", "occurrenceKey");',
  'CREATE UNIQUE INDEX "Workflow_workspaceId_systemKey_key" ON "Workflow"("workspaceId", "systemKey");',
  'ALTER TABLE "LifecycleDelivery" ADD CONSTRAINT "LifecycleDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "LifecycleDelivery" ADD CONSTRAINT "LifecycleDelivery_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
];

const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-24 lifecycle messages migration", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const sql = raw.toString("utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-24)", () => {
    const creates = code.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^(;]*/gi) ?? [];
    expect(creates).toHaveLength(4); // one table, three indexes
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /i);
    const addCols = code.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(addCols.map((a) => a.trim())).toEqual(['ADD COLUMN IF NOT EXISTS "systemKey" TEXT']);

    // Every FK is in its own duplicate_object block, CASCADE both ways.
    const blocks = code.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(2);
    expect((code.match(/FOREIGN KEY/g) ?? []).length).toBe(2);
    for (const [name, col, ref] of [
      ["LifecycleDelivery_workspaceId_fkey", "workspaceId", "Workspace"],
      ["LifecycleDelivery_workflowId_fkey", "workflowId", "Workflow"],
    ]) {
      const block = blocks.find((b) => b.includes(`"${name}"`));
      expect(block).toContain(
        `ALTER TABLE "LifecycleDelivery" ADD CONSTRAINT "${name}" FOREIGN KEY ("${col}") REFERENCES "${ref}"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
      );
      expect(block).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;/);
    }

    // Nothing destructive, no backfill, no type change.
    const statementsOnly = code.replace(/ON (DELETE|UPDATE) CASCADE/g, "");
    for (const bad of [/\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i, /ALTER COLUMN/i, /\bTYPE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i]) {
      expect({ bad: String(bad), hit: bad.test(statementsOnly) }).toEqual({ bad: String(bad), hit: false });
    }

    // Ordered after SP-10 and after the parallel SP-21/SP-20/SP-18 slots.
    expect(FOLDER.slice(0, 14) > "20261116130000").toBe(true);
    expect(FOLDER.slice(0, 14) > "20261117140000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    // Relative to the pinned predecessors, not adjacency (SP-20's
    // 20261117130000 may land between them).
    for (const before of Object.keys(PINNED)) {
      expect({ before, after: folders.indexOf(FOLDER) > folders.indexOf(before) }).toEqual({ before, after: true });
    }

    // LF only.
    expect(raw.includes(Buffer.from("\r\n"))).toBe(false);
  });

  it("equals prisma migrate diff apart from IF NOT EXISTS, the DO wrappers, lock_timeout and order", () => {
    const statements = code
      .replace(/^SET lock_timeout = '5s';$/m, "")
      .replace(/IF NOT EXISTS /g, "")
      .replace(/DO \$\$ BEGIN([\s\S]*?)EXCEPTION WHEN duplicate_object THEN NULL;\s*END \$\$;/g, "$1")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((s) => `${s};`);
    expect([...statements].sort()).toEqual([...PRISMA_DIFF].sort());
  });

  it("sets lock_timeout first", () => {
    expect(code.split(";")[0].trim()).toBe("SET lock_timeout = '5s'");
    expect((code.match(/^SET /gm) ?? []).length).toBe(1);
  });

  it.each(Object.entries(PINNED))("the earlier %s file is unchanged (sha256)", (folder, sha) => {
    expect(lfSha(readFileSync(join(MIGRATIONS, folder, "migration.sql")))).toBe(sha);
  });

  it("schema.prisma declares Workflow.systemKey and LifecycleDelivery as the plan names them", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
    const block = (name: string) => schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
    const wf = block("Workflow");
    expect(wf).toMatch(/\n\s+systemKey\s+String\?\n/);
    expect(wf).toMatch(/@@unique\(\[workspaceId, systemKey\]\)/);
    const ld = block("LifecycleDelivery");
    expect(ld).toMatch(/@@unique\(\[workflowId, entityId, occurrenceKey\]\)/);
    expect(ld).toMatch(/@@index\(\[workspaceId, createdAt\]\)/);
    expect(ld).toMatch(/workflow\s+Workflow\s+@relation\(fields: \[workflowId\], references: \[id\], onDelete: Cascade\)/);
    expect(ld).toMatch(/entityId\s+String\s/);
    expect(ld).not.toMatch(/entity\s+\w+\s+@relation/);
  });
});
