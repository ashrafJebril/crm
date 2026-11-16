import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261117130000_agent_config";
const PREVIOUS = "20261117120000_knowledge_upgrade";
/** sha256 of earlier files (LF, as committed). Never edit them. */
const PINNED: Record<string, string> = {
  // SP-21, applied to production.
  "20261117120000_knowledge_upgrade": "463dcac144c1c369fd40479007ec824a21e766c34238d19ab2705a3db6c4a1db",
};

/**
 * What `prisma migrate diff --from-schema-datamodel <a717d0d schema>
 * --to-schema-datamodel prisma/schema.prisma --script` printed for this change
 * (Prisma 5.22.0, run 2026-11-16, no DB), whitespace-collapsed. The file must
 * equal it apart from `IF NOT EXISTS`, the duplicate_object wrappers and the
 * lock_timeout.
 */
const PRISMA_DIFF = [
  'ALTER TABLE "Workspace" ADD COLUMN "onboardingState" JSONB;',
  'CREATE TABLE "AgentSettings" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "nameEn" TEXT, "nameAr" TEXT, ' +
    '"greeting" TEXT, "greetingAr" TEXT, "tone" TEXT[] DEFAULT ARRAY[]::TEXT[], "hoursMode" TEXT NOT NULL DEFAULT \'always\', ' +
    '"schedule" JSONB, "excludedTagIds" TEXT[] DEFAULT ARRAY[]::TEXT[], "stoppedAt" TIMESTAMP(3), "stoppedReason" TEXT, ' +
    '"stoppedById" TEXT, "publishState" TEXT NOT NULL DEFAULT \'none\', "version" INTEGER NOT NULL DEFAULT 0, ' +
    '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, ' +
    'CONSTRAINT "AgentSettings_pkey" PRIMARY KEY ("id") );',
  'CREATE TABLE "AgentSandboxThread" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "userId" TEXT NOT NULL, ' +
    '"messages" JSONB NOT NULL DEFAULT \'[]\', "transcript" JSONB NOT NULL DEFAULT \'[]\', "expiresAt" TIMESTAMP(3) NOT NULL, ' +
    '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, ' +
    'CONSTRAINT "AgentSandboxThread_pkey" PRIMARY KEY ("id") );',
  'CREATE UNIQUE INDEX "AgentSettings_workspaceId_key" ON "AgentSettings"("workspaceId");',
  'CREATE INDEX "AgentSandboxThread_expiresAt_idx" ON "AgentSandboxThread"("expiresAt");',
  'CREATE UNIQUE INDEX "AgentSandboxThread_workspaceId_userId_key" ON "AgentSandboxThread"("workspaceId", "userId");',
  'ALTER TABLE "AgentSettings" ADD CONSTRAINT "AgentSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "AgentSandboxThread" ADD CONSTRAINT "AgentSandboxThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "AgentSandboxThread" ADD CONSTRAINT "AgentSandboxThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
];

/** Hash as committed (LF), whatever the checkout's autocrlf did. */
const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-20 agent config migration", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const sql = raw.toString("utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-20)", () => {
    // Every CREATE TABLE / CREATE INDEX and the one ADD COLUMN is guarded.
    const creates = code.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^(;]*/gi) ?? [];
    expect(creates).toHaveLength(5); // two tables, three indexes
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /i);
    const addColumns = code.match(/ADD COLUMN[^;]*/gi) ?? [];
    expect(addColumns).toEqual(['ADD COLUMN IF NOT EXISTS "onboardingState" JSONB']);

    // Exact names (Global Constraints → Migration).
    for (const t of ["AgentSettings", "AgentSandboxThread"]) expect(code).toContain(`CREATE TABLE IF NOT EXISTS "${t}" (`);
    for (const name of ["AgentSettings_workspaceId_key", "AgentSandboxThread_workspaceId_userId_key", "AgentSandboxThread_expiresAt_idx"]) {
      expect(code).toContain(`"${name}"`);
    }

    // Every FK in its own duplicate_object block, all CASCADE.
    const fks: [string, string, string, string][] = [
      ["AgentSettings", "AgentSettings_workspaceId_fkey", "workspaceId", "Workspace"],
      ["AgentSandboxThread", "AgentSandboxThread_workspaceId_fkey", "workspaceId", "Workspace"],
      ["AgentSandboxThread", "AgentSandboxThread_userId_fkey", "userId", "User"],
    ];
    const blocks = code.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(fks.length);
    expect((code.match(/FOREIGN KEY/g) ?? []).length).toBe(fks.length);
    for (const [table, name, col, ref] of fks) {
      const block = blocks.find((b) => b.includes(`"${name}"`));
      expect(block).toBeDefined();
      expect(block).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${col}") REFERENCES "${ref}"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
      );
      expect(block).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;/);
    }

    // Nothing destructive. Workspace only gains the nullable column with no
    // default (metadata-only); every other ALTER is on the new tables.
    const outsideCreates = code.replace(/CREATE TABLE[\s\S]*?\);/g, "").replace(/ON (DELETE|UPDATE) CASCADE/g, "");
    for (const bad of [/\bDROP\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /ALTER COLUMN/i, /\bTYPE\b/i, /\bTRIGGER\b/i, /\bDEFAULT\b/i, /NOT NULL/i]) {
      expect({ bad: String(bad), hit: bad.test(outsideCreates) }).toEqual({ bad: String(bad), hit: false });
    }
    const altered = [...code.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(altered.filter((t) => t === "Workspace")).toHaveLength(1);
    for (const t of altered) expect(["Workspace", "AgentSettings", "AgentSandboxThread"]).toContain(t);
    expect(code).toMatch(/ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "onboardingState" JSONB;/);

    // lock_timeout first and only once (house style).
    expect(code.split(";")[0].trim()).toBe("SET lock_timeout = '5s'");
    expect((code.match(/^SET /gm) ?? []).length).toBe(1);
    expect(sql).toContain(`npx prisma migrate resolve --rolled-back ${FOLDER}`);

    // Ordered right after SP-21's applied migration.
    expect(FOLDER.slice(0, 14) > "20261117120000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders.indexOf(FOLDER)).toBeGreaterThan(0);
    expect(folders[folders.indexOf(FOLDER) - 1]).toBe(PREVIOUS);

    // LF only (Prisma checksums the exact bytes; .gitattributes enforces it on commit).
    expect(raw.includes(Buffer.from("\r\n"))).toBe(false);
  });

  it("equals prisma migrate diff apart from IF NOT EXISTS, the DO wrappers and lock_timeout", () => {
    const statements = code
      .replace(/^SET lock_timeout = '5s';$/m, "")
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

  it("schema.prisma declares the SP-20 models with the plan's names", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
    const block = (name: string) => schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
    const s = block("AgentSettings");
    expect(s).toMatch(/workspaceId\s+String\s+@unique/);
    expect(s).toMatch(/workspace\s+Workspace\s+@relation\("WorkspaceAgentSettings", fields: \[workspaceId\], references: \[id\], onDelete: Cascade\)/);
    expect(s).toMatch(/tone\s+String\[\]\s+@default\(\[\]\)/);
    expect(s).toMatch(/hoursMode\s+String\s+@default\("always"\)/);
    expect(s).toMatch(/excludedTagIds\s+String\[\]\s+@default\(\[\]\)/);
    expect(s).toMatch(/publishState\s+String\s+@default\("none"\)/);
    const t = block("AgentSandboxThread");
    expect(t).toMatch(/@@unique\(\[workspaceId, userId\]\)/);
    expect(t).toMatch(/@@index\(\[expiresAt\]\)/);
    expect(t).toMatch(/user\s+User\s+@relation\("UserAgentSandboxThreads", fields: \[userId\], references: \[id\], onDelete: Cascade\)/);
    expect(block("Workspace")).toMatch(/onboardingState\s+Json\?/);
    expect(block("Workspace")).toMatch(/agentSettings\s+AgentSettings\?\s+@relation\("WorkspaceAgentSettings"\)/);
    expect(block("User")).toMatch(/agentSandboxThreads\s+AgentSandboxThread\[\]\s+@relation\("UserAgentSandboxThreads"\)/);
  });
});
