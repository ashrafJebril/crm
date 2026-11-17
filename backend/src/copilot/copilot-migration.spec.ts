import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261117140000_copilot";
/** sha256 of the predecessors (LF, as committed). Never edit them. */
const PINNED: Record<string, string> = {
  // SP-21, applied to production.
  "20261117120000_knowledge_upgrade": "463dcac144c1c369fd40479007ec824a21e766c34238d19ab2705a3db6c4a1db",
  // SP-20.
  "20261117130000_agent_config": "0389880cc4dde498652acd083596b9e5e89f303e575e275e646784fde617f5ce",
};
const NEW_TABLES = ["CopilotSession", "CopilotMessage", "CopilotPendingAction", "CopilotAttachment", "CopilotActionAudit"];

/**
 * What `prisma migrate diff --from-schema-datamodel <fdd11c9 schema>
 * --to-schema-datamodel prisma/schema.prisma --script` printed for this change
 * (Prisma 5.22.0, run 2026-11-17, no DB), whitespace-collapsed. The file must
 * equal it apart from `IF NOT EXISTS`, the duplicate_object wrappers and the
 * lock_timeout.
 */
const PRISMA_DIFF = [
  "CREATE TABLE \"CopilotSession\" ( \"id\" TEXT NOT NULL, \"workspaceId\" TEXT NOT NULL, \"userId\" TEXT NOT NULL, \"persona\" TEXT NOT NULL DEFAULT 'aida', \"title\" TEXT, \"runningUntil\" TIMESTAMP(3), \"tainted\" BOOLEAN NOT NULL DEFAULT false, \"deletedAt\" TIMESTAMP(3), \"createdAt\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, \"updatedAt\" TIMESTAMP(3) NOT NULL, CONSTRAINT \"CopilotSession_pkey\" PRIMARY KEY (\"id\") );",
  "CREATE TABLE \"CopilotMessage\" ( \"id\" TEXT NOT NULL, \"workspaceId\" TEXT NOT NULL, \"sessionId\" TEXT NOT NULL, \"role\" TEXT NOT NULL, \"text\" TEXT NOT NULL DEFAULT '', \"content\" JSONB, \"references\" JSONB, \"attachments\" JSONB, \"sources\" JSONB, \"pageContext\" JSONB, \"usage\" JSONB, \"createdAt\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"CopilotMessage_pkey\" PRIMARY KEY (\"id\") );",
  "CREATE TABLE \"CopilotPendingAction\" ( \"id\" TEXT NOT NULL, \"workspaceId\" TEXT NOT NULL, \"sessionId\" TEXT NOT NULL, \"userId\" TEXT NOT NULL, \"tool\" TEXT NOT NULL, \"argsJson\" JSONB NOT NULL, \"argsHash\" TEXT NOT NULL, \"card\" JSONB NOT NULL, \"permission\" TEXT NOT NULL, \"status\" TEXT NOT NULL DEFAULT 'PENDING', \"decidedBy\" TEXT, \"decidedById\" TEXT, \"decidedAt\" TIMESTAMP(3), \"feedback\" TEXT, \"refusal\" TEXT, \"resultJson\" JSONB, \"errorKey\" TEXT, \"expiresAt\" TIMESTAMP(3) NOT NULL, \"createdAt\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"CopilotPendingAction_pkey\" PRIMARY KEY (\"id\") );",
  "CREATE TABLE \"CopilotAttachment\" ( \"id\" TEXT NOT NULL, \"workspaceId\" TEXT NOT NULL, \"userId\" TEXT NOT NULL, \"sessionId\" TEXT, \"mediaId\" TEXT, \"fileName\" TEXT NOT NULL, \"mimeType\" TEXT NOT NULL, \"sizeBytes\" INTEGER NOT NULL, \"text\" TEXT, \"truncated\" BOOLEAN NOT NULL DEFAULT false, \"sentAt\" TIMESTAMP(3), \"createdAt\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"CopilotAttachment_pkey\" PRIMARY KEY (\"id\") );",
  "CREATE TABLE \"CopilotActionAudit\" ( \"id\" TEXT NOT NULL, \"workspaceId\" TEXT NOT NULL, \"actionId\" TEXT NOT NULL, \"event\" TEXT NOT NULL, \"actorId\" TEXT, \"tool\" TEXT NOT NULL, \"detail\" JSONB, \"createdAt\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \"CopilotActionAudit_pkey\" PRIMARY KEY (\"id\") );",
  "CREATE INDEX \"CopilotSession_workspaceId_userId_updatedAt_idx\" ON \"CopilotSession\"(\"workspaceId\", \"userId\", \"updatedAt\");",
  "CREATE INDEX \"CopilotMessage_sessionId_createdAt_idx\" ON \"CopilotMessage\"(\"sessionId\", \"createdAt\");",
  "CREATE INDEX \"CopilotMessage_workspaceId_idx\" ON \"CopilotMessage\"(\"workspaceId\");",
  "CREATE INDEX \"CopilotPendingAction_workspaceId_userId_status_idx\" ON \"CopilotPendingAction\"(\"workspaceId\", \"userId\", \"status\");",
  "CREATE INDEX \"CopilotPendingAction_sessionId_idx\" ON \"CopilotPendingAction\"(\"sessionId\");",
  "CREATE INDEX \"CopilotAttachment_workspaceId_userId_idx\" ON \"CopilotAttachment\"(\"workspaceId\", \"userId\");",
  "CREATE INDEX \"CopilotAttachment_sessionId_idx\" ON \"CopilotAttachment\"(\"sessionId\");",
  "CREATE INDEX \"CopilotAttachment_mediaId_idx\" ON \"CopilotAttachment\"(\"mediaId\");",
  "CREATE INDEX \"CopilotActionAudit_workspaceId_actionId_createdAt_idx\" ON \"CopilotActionAudit\"(\"workspaceId\", \"actionId\", \"createdAt\");",
  "ALTER TABLE \"CopilotSession\" ADD CONSTRAINT \"CopilotSession_workspaceId_fkey\" FOREIGN KEY (\"workspaceId\") REFERENCES \"Workspace\"(\"id\") ON DELETE CASCADE ON UPDATE CASCADE;",
  "ALTER TABLE \"CopilotSession\" ADD CONSTRAINT \"CopilotSession_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"User\"(\"id\") ON DELETE CASCADE ON UPDATE CASCADE;",
  "ALTER TABLE \"CopilotMessage\" ADD CONSTRAINT \"CopilotMessage_sessionId_fkey\" FOREIGN KEY (\"sessionId\") REFERENCES \"CopilotSession\"(\"id\") ON DELETE CASCADE ON UPDATE CASCADE;",
  "ALTER TABLE \"CopilotPendingAction\" ADD CONSTRAINT \"CopilotPendingAction_sessionId_fkey\" FOREIGN KEY (\"sessionId\") REFERENCES \"CopilotSession\"(\"id\") ON DELETE CASCADE ON UPDATE CASCADE;",
  "ALTER TABLE \"CopilotAttachment\" ADD CONSTRAINT \"CopilotAttachment_mediaId_fkey\" FOREIGN KEY (\"mediaId\") REFERENCES \"Media\"(\"id\") ON DELETE SET NULL ON UPDATE CASCADE;",
];

/** Hash as committed (LF), whatever the checkout's autocrlf did. */
const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-18 copilot migration", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const sql = raw.toString("utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-18)", () => {
    // Every CREATE TABLE / CREATE INDEX is guarded.
    const creates = code.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^(;]*/gi) ?? [];
    expect(creates).toHaveLength(14); // five tables, nine indexes
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /i);

    // Exact names (Global Constraints → Migration).
    for (const t of NEW_TABLES) expect(code).toContain(`CREATE TABLE IF NOT EXISTS "${t}" (`);
    for (const name of [
      "CopilotSession_workspaceId_userId_updatedAt_idx",
      "CopilotMessage_sessionId_createdAt_idx",
      "CopilotMessage_workspaceId_idx",
      "CopilotPendingAction_workspaceId_userId_status_idx",
      "CopilotPendingAction_sessionId_idx",
      "CopilotAttachment_workspaceId_userId_idx",
      "CopilotAttachment_sessionId_idx",
      "CopilotAttachment_mediaId_idx",
      "CopilotActionAudit_workspaceId_actionId_createdAt_idx",
    ]) {
      expect(code).toContain(`"${name}"`);
    }

    // Every FK in its own duplicate_object block, with the plan's actions.
    const fks: [string, string, string, string, string][] = [
      ["CopilotSession", "CopilotSession_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["CopilotSession", "CopilotSession_userId_fkey", "userId", "User", "CASCADE"],
      ["CopilotMessage", "CopilotMessage_sessionId_fkey", "sessionId", "CopilotSession", "CASCADE"],
      ["CopilotPendingAction", "CopilotPendingAction_sessionId_fkey", "sessionId", "CopilotSession", "CASCADE"],
      ["CopilotAttachment", "CopilotAttachment_mediaId_fkey", "mediaId", "Media", "SET NULL"],
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

    // Nothing destructive; only the new tables are altered; no Ads* change.
    const statementsOnly = code.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL)/g, "");
    for (const bad of [/\bDROP\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /ALTER COLUMN/i, /\bTYPE\b/i, /\bTRIGGER\b/i, /ADD COLUMN/i]) {
      expect({ bad: String(bad), hit: bad.test(statementsOnly) }).toEqual({ bad: String(bad), hit: false });
    }
    const altered = [...code.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    for (const t of altered) expect(NEW_TABLES).toContain(t);
    expect(code).not.toMatch(/"Ads[A-Z]\w*"/);

    // lock_timeout first and only once (house style).
    expect(code.split(";")[0].trim()).toBe("SET lock_timeout = '5s'");
    expect((code.match(/^SET /gm) ?? []).length).toBe(1);
    expect(sql).toContain(`npx prisma migrate resolve --rolled-back ${FOLDER}`);

    // After the pinned predecessors (not adjacency: SP-24's 20261117150000 and
    // SP-26's 20261118120000 sort after this folder).
    expect(FOLDER.slice(0, 14) > "20261117130000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders.indexOf(FOLDER)).toBeGreaterThan(0);
    for (const before of Object.keys(PINNED)) {
      expect({ before, after: folders.indexOf(FOLDER) > folders.indexOf(before) }).toEqual({ before, after: true });
    }

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

  it("schema.prisma declares the SP-18 models with the plan's names", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
    const block = (name: string) => schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
    const s = block("CopilotSession");
    expect(s).toMatch(/workspace\s+Workspace\s+@relation\("WorkspaceCopilotSessions", fields: \[workspaceId\], references: \[id\], onDelete: Cascade\)/);
    expect(s).toMatch(/user\s+User\s+@relation\("UserCopilotSessions", fields: \[userId\], references: \[id\], onDelete: Cascade\)/);
    expect(s).toMatch(/persona\s+String\s+@default\("aida"\)/);
    expect(s).toMatch(/tainted\s+Boolean\s+@default\(false\)/);
    expect(block("CopilotPendingAction")).toMatch(/status\s+String\s+@default\("PENDING"\)/);
    expect(block("CopilotAttachment")).toMatch(/media\s+Media\?\s+@relation\("MediaCopilotAttachments", fields: \[mediaId\], references: \[id\], onDelete: SetNull\)/);
    expect(block("CopilotAttachment")).toMatch(/sessionId\s+String\?/);
    expect(block("Workspace")).toMatch(/copilotSessions\s+CopilotSession\[\]\s+@relation\("WorkspaceCopilotSessions"\)/);
    expect(block("User")).toMatch(/copilotSessions\s+CopilotSession\[\]\s+@relation\("UserCopilotSessions"\)/);
    expect(block("Media")).toMatch(/copilotAttachments\s+CopilotAttachment\[\]\s+@relation\("MediaCopilotAttachments"\)/);
  });
});
