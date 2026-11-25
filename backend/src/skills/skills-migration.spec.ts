import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261117160000_skills_gallery";
/** sha256 of earlier files (LF, as committed). Never edit them. */
const PINNED: Record<string, string> = {
  "20261116130000_bookings_catalog": "913dad261ab4f163019f2d3c3c1b8a8bdf98ca08e233bcad489aa373aef08875",
  "20261117120000_knowledge_upgrade": "463dcac144c1c369fd40479007ec824a21e766c34238d19ab2705a3db6c4a1db",
  "20261117130000_agent_config": "0389880cc4dde498652acd083596b9e5e89f303e575e275e646784fde617f5ce",
  "20261117150000_lifecycle_messages": "f77f8fd558338996675b18b4d757ebb8117ceb512b364fd3b3d009315a77ce34",
  // SP-26: merged, and sorts AFTER this folder (no ordering assertion against it).
  "20261118120000_members_security": "f0a7a531550ffdf36bdfb94d24fc22affdd20d3094ec303c01e44cd469635767",
};
/** Pinned folders that must sort before this one. */
const BEFORE = [
  "20261116130000_bookings_catalog",
  "20261117120000_knowledge_upgrade",
  "20261117130000_agent_config",
  "20261117150000_lifecycle_messages",
];

/**
 * What `prisma migrate diff --from-schema-datamodel <832ea37 schema>
 * --to-schema-datamodel prisma/schema.prisma --script` yields (Prisma 5.22),
 * whitespace-collapsed. No `prisma migrate` ran against a database (ruling 14).
 */
const PRISMA_DIFF = [
  'CREATE TABLE "SkillInstall" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "skillKey" TEXT NOT NULL, ' +
    '"installedVersion" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT \'enabled\', "config" JSONB NOT NULL DEFAULT \'{}\', ' +
    '"needsConfig" BOOLEAN NOT NULL DEFAULT false, "lastAppliedAt" TIMESTAMP(3), "lastError" TEXT, "installedById" TEXT, ' +
    '"version" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
    '"updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "SkillInstall_pkey" PRIMARY KEY ("id") );',
  'CREATE TABLE "AgentToolCall" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "tool" TEXT NOT NULL, "skillKey" TEXT, ' +
    '"outcome" TEXT NOT NULL, "errorCode" TEXT, "durationMs" INTEGER NOT NULL, "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
    'CONSTRAINT "AgentToolCall_pkey" PRIMARY KEY ("id") );',
  'CREATE UNIQUE INDEX "SkillInstall_workspaceId_skillKey_key" ON "SkillInstall"("workspaceId", "skillKey");',
  'CREATE INDEX "AgentToolCall_workspaceId_at_idx" ON "AgentToolCall"("workspaceId", "at");',
  'CREATE INDEX "AgentToolCall_workspaceId_skillKey_at_idx" ON "AgentToolCall"("workspaceId", "skillKey", "at");',
  'ALTER TABLE "SkillInstall" ADD CONSTRAINT "SkillInstall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "SkillInstall" ADD CONSTRAINT "SkillInstall_installedById_fkey" FOREIGN KEY ("installedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
  'ALTER TABLE "AgentToolCall" ADD CONSTRAINT "AgentToolCall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
];

const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-22 skills gallery migration", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const code = raw
    .toString("utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-22)", () => {
    const creates = code.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^(;]*/gi) ?? [];
    expect(creates).toHaveLength(5); // two tables, three indexes
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /i);

    const blocks = code.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(3);
    expect((code.match(/FOREIGN KEY/g) ?? []).length).toBe(3);
    for (const [table, name, col, ref, onDelete] of [
      ["SkillInstall", "SkillInstall_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["SkillInstall", "SkillInstall_installedById_fkey", "installedById", "User", "SET NULL"],
      ["AgentToolCall", "AgentToolCall_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
    ]) {
      const block = blocks.find((b) => b.includes(`"${name}"`));
      expect(block).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${col}") REFERENCES "${ref}"("id") ON DELETE ${onDelete} ON UPDATE CASCADE;`,
      );
      expect(block).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;/);
    }

    // Nothing destructive; the only ALTERs are the FK adds inside their blocks.
    const outsideBlocks = code.replace(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g, "").replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL)/g, "");
    for (const bad of [/\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTYPE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i]) {
      expect({ bad: String(bad), hit: bad.test(outsideBlocks) }).toEqual({ bad: String(bad), hit: false });
    }
    for (const b of blocks) expect(b.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL)/g, "")).not.toMatch(/\b(UPDATE|DELETE|DROP|ALTER COLUMN)\b/);

    // Ordering: after SP-24's lifecycle messages and every pinned predecessor
    // that sorts before it (relative, not adjacency).
    expect(FOLDER.slice(0, 14) > "20261117150000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    for (const before of BEFORE) {
      expect({ before, after: folders.indexOf(FOLDER) > folders.indexOf(before) }).toEqual({ before, after: true });
    }

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
  });

  it.each(Object.entries(PINNED))("the earlier %s file is unchanged (sha256)", (folder, sha) => {
    expect(lfSha(readFileSync(join(MIGRATIONS, folder, "migration.sql")))).toBe(sha);
  });
});
