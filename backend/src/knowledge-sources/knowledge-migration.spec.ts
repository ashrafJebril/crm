import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261117120000_knowledge_upgrade";
/** sha256 of earlier files (LF, as committed). Never edit them. */
const PINNED: Record<string, string> = {
  "20261116120000_support_tickets": "555000f79d7d764bf69429a0bd56b52b4893802e56a5e4cc01da949ef7b6e22c",
  "20261116130000_bookings_catalog": "913dad261ab4f163019f2d3c3c1b8a8bdf98ca08e233bcad489aa373aef08875",
};

/**
 * What `prisma migrate diff --from-schema-datamodel <c7bb50f schema>
 * --to-schema-datamodel prisma/schema.prisma --script` printed for this change
 * (Prisma 5.22.0, run 2026-11-16, no DB), whitespace-collapsed. The file must
 * equal it apart from `IF NOT EXISTS`, the duplicate_object wrappers, the
 * lock_timeout and the FTS expression index.
 */
const PRISMA_DIFF = [
  'CREATE TABLE "KnowledgeSource" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "kind" TEXT NOT NULL, ' +
    '"status" TEXT NOT NULL DEFAULT \'ready\', "error" TEXT, "title" TEXT NOT NULL, "bodyJson" JSONB, "body" TEXT, "question" TEXT, ' +
    '"order" INTEGER NOT NULL DEFAULT 0, "mediaId" TEXT, "typedKind" TEXT, "url" TEXT, "scope" TEXT, "schedule" TEXT, ' +
    '"nextSyncAt" TIMESTAMP(3), "lastSyncAt" TIMESTAMP(3), "syncStartedAt" TIMESTAMP(3), "refreshRequestedAt" TIMESTAMP(3), ' +
    '"consecutiveFailures" INTEGER NOT NULL DEFAULT 0, "lastRun" JSONB, "itemCount" INTEGER NOT NULL DEFAULT 0, "contentHash" TEXT, ' +
    '"leaseUntil" TIMESTAMP(3), "upstream" JSONB, "publishState" TEXT NOT NULL DEFAULT \'none\', "legacyRef" TEXT, "createdById" TEXT, ' +
    '"version" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, ' +
    'CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id") );',
  'CREATE TABLE "KnowledgePage" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "url" TEXT NOT NULL, ' +
    '"urlKey" TEXT NOT NULL, "state" TEXT NOT NULL, "httpStatus" INTEGER, "title" TEXT, "contentHash" TEXT, ' +
    '"missedRuns" INTEGER NOT NULL DEFAULT 0, "lastSeenAt" TIMESTAMP(3), "lastReadAt" TIMESTAMP(3), "removedAt" TIMESTAMP(3), ' +
    '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "KnowledgePage_pkey" PRIMARY KEY ("id") );',
  'CREATE TABLE "KnowledgeChunk" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "pageId" TEXT, ' +
    '"ord" INTEGER NOT NULL, "heading" TEXT, "text" TEXT NOT NULL, "rowRef" INTEGER, "validTo" DATE, ' +
    '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id") );',
  'CREATE INDEX "KnowledgeSource_workspaceId_kind_order_idx" ON "KnowledgeSource"("workspaceId", "kind", "order");',
  'CREATE INDEX "KnowledgeSource_status_nextSyncAt_idx" ON "KnowledgeSource"("status", "nextSyncAt");',
  'CREATE INDEX "KnowledgeSource_mediaId_idx" ON "KnowledgeSource"("mediaId");',
  'CREATE UNIQUE INDEX "KnowledgeSource_workspaceId_legacyRef_key" ON "KnowledgeSource"("workspaceId", "legacyRef");',
  'CREATE INDEX "KnowledgePage_workspaceId_idx" ON "KnowledgePage"("workspaceId");',
  'CREATE UNIQUE INDEX "KnowledgePage_sourceId_urlKey_key" ON "KnowledgePage"("sourceId", "urlKey");',
  'CREATE INDEX "KnowledgeChunk_workspaceId_sourceId_idx" ON "KnowledgeChunk"("workspaceId", "sourceId");',
  'CREATE INDEX "KnowledgeChunk_pageId_idx" ON "KnowledgeChunk"("pageId");',
  'ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
  'ALTER TABLE "KnowledgePage" ADD CONSTRAINT "KnowledgePage_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "KnowledgePage"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
];
const FTS = 'CREATE INDEX IF NOT EXISTS "KnowledgeChunk_fts_idx" ON "KnowledgeChunk" USING GIN (to_tsvector(\'simple\', "text"));';

/** Hash as committed (LF), whatever the checkout's autocrlf did. */
const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-21 knowledge migration", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const sql = raw.toString("utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-21)", () => {
    // Every CREATE TABLE / CREATE INDEX is guarded.
    const creates = code.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^(;]*/gi) ?? [];
    expect(creates).toHaveLength(12); // three tables, nine indexes (incl. FTS)
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /i);

    // Exact names (Global Constraints → Migration).
    for (const t of ["KnowledgeSource", "KnowledgePage", "KnowledgeChunk"]) expect(code).toContain(`CREATE TABLE IF NOT EXISTS "${t}" (`);
    for (const name of [
      "KnowledgeSource_workspaceId_legacyRef_key",
      "KnowledgeSource_workspaceId_kind_order_idx",
      "KnowledgeSource_status_nextSyncAt_idx",
      "KnowledgeSource_mediaId_idx",
      "KnowledgePage_sourceId_urlKey_key",
      "KnowledgePage_workspaceId_idx",
      "KnowledgeChunk_workspaceId_sourceId_idx",
      "KnowledgeChunk_pageId_idx",
      "KnowledgeChunk_fts_idx",
    ]) {
      expect(code).toContain(`"${name}"`);
    }
    expect(code).toContain(FTS);

    // Every FK in its own duplicate_object block, with the plan's actions.
    const fks: [string, string, string, string, string][] = [
      ["KnowledgeSource", "KnowledgeSource_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["KnowledgeSource", "KnowledgeSource_mediaId_fkey", "mediaId", "Media", "SET NULL"],
      ["KnowledgePage", "KnowledgePage_sourceId_fkey", "sourceId", "KnowledgeSource", "CASCADE"],
      ["KnowledgeChunk", "KnowledgeChunk_sourceId_fkey", "sourceId", "KnowledgeSource", "CASCADE"],
      ["KnowledgeChunk", "KnowledgeChunk_pageId_fkey", "pageId", "KnowledgePage", "CASCADE"],
    ];
    const blocks = code.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(fks.length);
    expect((code.match(/FOREIGN KEY/g) ?? []).length).toBe(fks.length);
    for (const [table, name, col, ref, onDelete] of fks) {
      const block = blocks.find((b) => b.includes(`"${name}"`));
      expect(block).toBeDefined();
      expect(block).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${col}") REFERENCES "${ref}"("id") ON DELETE ${onDelete} ON UPDATE CASCADE;`,
      );
      expect(block).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;/);
    }

    // Nothing destructive; only the new tables are altered.
    const statementsOnly = code.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL)/g, "");
    for (const bad of [/\bDROP\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /ALTER COLUMN/i, /\bTYPE\b/i, /\bTRIGGER\b/i, /ADD COLUMN/i]) {
      expect({ bad: String(bad), hit: bad.test(statementsOnly) }).toEqual({ bad: String(bad), hit: false });
    }
    const altered = [...code.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    for (const t of altered) expect(["KnowledgeSource", "KnowledgePage", "KnowledgeChunk"]).toContain(t);

    // lock_timeout first and only once.
    expect(code.split(";")[0].trim()).toBe("SET lock_timeout = '5s'");
    expect((code.match(/^SET /gm) ?? []).length).toBe(1);
    expect(sql).toContain("npx prisma migrate resolve --rolled-back 20261117120000_knowledge_upgrade");

    // Ordered after SP-10 and SP-11 (pending) and every applied migration.
    expect(FOLDER.slice(0, 14) > "20261116140000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders[folders.length - 1]).toBe(FOLDER);

    // LF only (Prisma checksums the exact bytes; .gitattributes enforces it on commit).
    expect(raw.includes(Buffer.from("\r\n"))).toBe(false);
  });

  it("equals prisma migrate diff apart from IF NOT EXISTS, the DO wrappers, lock_timeout and the FTS index", () => {
    const statements = code
      .replace(/^SET lock_timeout = '5s';$/m, "")
      .replace(FTS, "")
      .replace(/IF NOT EXISTS /g, "")
      .replace(/DO \$\$ BEGIN([\s\S]*?)EXCEPTION WHEN duplicate_object THEN NULL;\s*END \$\$;/g, "$1")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((s) => `${s};`);
    expect(statements).toEqual(PRISMA_DIFF);
  });

  it.each(Object.entries(PINNED))("the earlier %s file is unchanged (sha256)", (folder, sha) => {
    expect(lfSha(readFileSync(join(MIGRATIONS, folder, "migration.sql")))).toBe(sha);
  });

  it("schema.prisma declares the SP-21 models with the plan's names", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
    const block = (name: string) => schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
    const src = block("KnowledgeSource");
    expect(src).toMatch(/workspace\s+Workspace\s+@relation\("WorkspaceKnowledgeSources", fields: \[workspaceId\], references: \[id\], onDelete: Cascade\)/);
    expect(src).toMatch(/media\s+Media\?\s+@relation\("MediaKnowledgeSources", fields: \[mediaId\], references: \[id\], onDelete: SetNull\)/);
    expect(src).toMatch(/status\s+String\s+@default\("ready"\)/);
    expect(src).toMatch(/publishState\s+String\s+@default\("none"\)/);
    expect(src).toMatch(/@@unique\(\[workspaceId, legacyRef\]\)/);
    expect(block("KnowledgePage")).toMatch(/@@unique\(\[sourceId, urlKey\]\)/);
    expect(block("KnowledgeChunk")).toMatch(/validTo\s+DateTime\?\s+@db\.Date/);
    expect(block("Workspace")).toMatch(/knowledgeSources\s+KnowledgeSource\[\]\s+@relation\("WorkspaceKnowledgeSources"\)/);
    expect(block("Media")).toMatch(/knowledgeSources\s+KnowledgeSource\[\]\s+@relation\("MediaKnowledgeSources"\)/);
  });
});
