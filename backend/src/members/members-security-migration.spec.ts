import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261118120000_members_security";
/** sha256 of earlier files (LF, as committed). Never edit them. SP-09's,
 *  SP-10's, SP-11's and SP-21's are applied; SP-24's is merged but not yet
 *  applied when this was written. */
const PINNED: Record<string, string> = {
  "20261116120000_support_tickets": "555000f79d7d764bf69429a0bd56b52b4893802e56a5e4cc01da949ef7b6e22c",
  "20261116130000_bookings_catalog": "913dad261ab4f163019f2d3c3c1b8a8bdf98ca08e233bcad489aa373aef08875",
  "20261116140000_insights_home": "a203771a9711c07a15bd26ab41635af9e2177ac0cdb767b434242d9d36ba9013",
  "20261117120000_knowledge_upgrade": "463dcac144c1c369fd40479007ec824a21e766c34238d19ab2705a3db6c4a1db",
  "20261117150000_lifecycle_messages": "f77f8fd558338996675b18b4d757ebb8117ceb512b364fd3b3d009315a77ce34",
};

/**
 * What `prisma migrate diff --from-schema-datamodel <9c101d4 schema>
 * --to-schema-datamodel prisma/schema.prisma --script` yields for this change
 * (Prisma 5.22), whitespace-collapsed. No `prisma migrate` command was run
 * against a database (ruling 13). The file must equal it apart from
 * `IF NOT EXISTS`, the duplicate_object wrappers, the lock_timeout line and
 * statement order.
 */
const PRISMA_DIFF = [
  'ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "totpEnabledAt" TIMESTAMP(3), ' +
    'ADD COLUMN "totpLastStep" INTEGER, ADD COLUMN "totpPendingEnc" TEXT, ' +
    'ADD COLUMN "totpRecoveryHashes" TEXT[] DEFAULT ARRAY[]::TEXT[], ADD COLUMN "totpSecretEnc" TEXT;',
  'CREATE TABLE "Invitation" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "email" TEXT NOT NULL, "roleId" TEXT, ' +
    '"lang" TEXT NOT NULL DEFAULT \'ar\', "tokenHash" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, ' +
    '"acceptedAt" TIMESTAMP(3), "acceptedById" TEXT, "revokedAt" TIMESTAMP(3), "invitedById" TEXT, ' +
    '"sendCount" INTEGER NOT NULL DEFAULT 1, "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
    '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id") );',
  'CREATE TABLE "AuditLog" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "actorId" TEXT, ' +
    '"actorKind" TEXT NOT NULL DEFAULT \'user\', "action" TEXT NOT NULL, "targetKind" TEXT NOT NULL, "targetId" TEXT, ' +
    '"meta" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id") );',
  'CREATE TABLE "PasswordReset" ( "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, ' +
    '"expiresAt" TIMESTAMP(3) NOT NULL, "usedAt" TIMESTAMP(3), "requestedIp" TEXT, ' +
    '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id") );',
  'CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");',
  'CREATE INDEX "Invitation_workspaceId_email_idx" ON "Invitation"("workspaceId", "email");',
  'CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");',
  'CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");',
  'CREATE INDEX "AuditLog_workspaceId_action_createdAt_idx" ON "AuditLog"("workspaceId", "action", "createdAt");',
  'CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");',
  'CREATE INDEX "PasswordReset_userId_createdAt_idx" ON "PasswordReset"("userId", "createdAt");',
  'ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
  'ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
  'ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
  'ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
];

const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-26 members and security migration", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const sql = raw.toString("utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-26)", () => {
    const creates = code.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^(;]*/gi) ?? [];
    expect(creates).toHaveLength(10); // three tables, seven indexes
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /i);
    const addCols = code.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(addCols).toHaveLength(6);
    for (const a of addCols) expect(a).toMatch(/^ADD COLUMN IF NOT EXISTS "/);

    // Every FK is in its own duplicate_object block, with the planned actions.
    const blocks = code.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(6);
    expect((code.match(/FOREIGN KEY/g) ?? []).length).toBe(6);
    for (const [table, name, col, ref, onDelete] of [
      ["Invitation", "Invitation_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["Invitation", "Invitation_roleId_fkey", "roleId", "Role", "SET NULL"],
      ["Invitation", "Invitation_acceptedById_fkey", "acceptedById", "User", "SET NULL"],
      ["Invitation", "Invitation_invitedById_fkey", "invitedById", "User", "SET NULL"],
      ["AuditLog", "AuditLog_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["PasswordReset", "PasswordReset_userId_fkey", "userId", "User", "CASCADE"],
    ]) {
      const block = blocks.find((b) => b.includes(`"${name}"`));
      expect(block).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${col}") REFERENCES "${ref}"("id") ON DELETE ${onDelete} ON UPDATE CASCADE;`,
      );
      expect(block).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;/);
    }
    // AuditLog.actorId has no FK: the log outlives the user.
    expect(code).not.toMatch(/"actorId"\)\s*REFERENCES/);

    // Nothing destructive, no backfill, no type change.
    const statementsOnly = code.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL)/g, "");
    for (const bad of [/\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i, /ALTER COLUMN/i, /\bTYPE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i]) {
      expect({ bad: String(bad), hit: bad.test(statementsOnly) }).toEqual({ bad: String(bad), hit: false });
    }

    // Ordered after SP-11 and after every pinned predecessor. Relative, not
    // adjacency: SP-20's 20261117130000 and SP-18's 20261117140000 land between.
    expect(FOLDER.slice(0, 14) > "20261116140000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders).toContain(FOLDER);
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

  it("schema.prisma declares the SP-26 models and User columns as the plan names them", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
    const block = (name: string) => schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
    const inv = block("Invitation");
    expect(inv).toMatch(/tokenHash\s+String\s+@unique/);
    expect(inv).toMatch(/@@index\(\[workspaceId, email\]\)/);
    expect(inv).toMatch(/@@index\(\[email\]\)/);
    expect(inv).toMatch(/role\s+Role\?\s+@relation\("RoleInvitations", fields: \[roleId\], references: \[id\], onDelete: SetNull\)/);
    const audit = block("AuditLog");
    expect(audit).toMatch(/actorId\s+String\?\n/);
    expect(audit).toMatch(/@@index\(\[workspaceId, action, createdAt\]\)/);
    const reset = block("PasswordReset");
    expect(reset).toMatch(/@@index\(\[userId, createdAt\]\)/);
    const user = block("User");
    for (const col of ["totpSecretEnc", "totpPendingEnc", "totpEnabledAt", "totpLastStep"]) {
      expect(user).toMatch(new RegExp(`\\n\\s+${col}\\s+\\w+\\?`));
    }
    expect(user).toMatch(/totpRecoveryHashes\s+String\[\]\s+@default\(\[\]\)/);
    expect(user).toMatch(/sessionVersion\s+Int\s+@default\(0\)/);
  });
});
