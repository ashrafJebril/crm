import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261118130000_api_keys_webhooks";
/** sha256 of earlier files (LF, as committed). Never edit them. Ordering is
 *  relative, not adjacency: other SPs' migrations may land in between. */
const PINNED: Record<string, string> = {
  "20261116120000_support_tickets": "555000f79d7d764bf69429a0bd56b52b4893802e56a5e4cc01da949ef7b6e22c",
  "20261116130000_bookings_catalog": "913dad261ab4f163019f2d3c3c1b8a8bdf98ca08e233bcad489aa373aef08875",
  "20261116140000_insights_home": "a203771a9711c07a15bd26ab41635af9e2177ac0cdb767b434242d9d36ba9013",
  "20261117120000_knowledge_upgrade": "463dcac144c1c369fd40479007ec824a21e766c34238d19ab2705a3db6c4a1db",
  "20261117130000_agent_config": "0389880cc4dde498652acd083596b9e5e89f303e575e275e646784fde617f5ce",
  "20261117150000_lifecycle_messages": "f77f8fd558338996675b18b4d757ebb8117ceb512b364fd3b3d009315a77ce34",
  "20261118120000_members_security": "f0a7a531550ffdf36bdfb94d24fc22affdd20d3094ec303c01e44cd469635767",
};

/**
 * What `prisma migrate diff` (Prisma 5.22) yields for the SP-27 models,
 * whitespace-collapsed. Hand-derived in Prisma's output format; no
 * `prisma migrate` command was run. The file must equal it apart from
 * `IF NOT EXISTS`, the duplicate_object wrappers, the lock_timeout line and
 * statement order.
 */
const PRISMA_DIFF = [
  'CREATE TABLE "ApiKey" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "prefix" TEXT NOT NULL, ' +
    '"hash" TEXT NOT NULL, "scopes" JSONB NOT NULL, "createdById" TEXT NOT NULL, "expiresAt" TIMESTAMP(3), ' +
    '"lastUsedAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
    'CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id") );',
  'CREATE TABLE "WebhookEndpoint" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "url" TEXT NOT NULL, "description" TEXT, ' +
    '"events" TEXT[], "secretEnc" TEXT NOT NULL, "previousSecretEnc" TEXT, "previousSecretExpiresAt" TIMESTAMP(3), ' +
    '"active" BOOLEAN NOT NULL DEFAULT true, "disabledReason" TEXT, "failingSince" TIMESTAMP(3), "createdById" TEXT, ' +
    '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, ' +
    'CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id") );',
  'CREATE TABLE "WebhookDelivery" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "endpointId" TEXT NOT NULL, ' +
    '"eventId" TEXT NOT NULL, "event" TEXT NOT NULL, "payload" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT \'pending\', ' +
    '"attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
    '"leaseUntil" TIMESTAMP(3), "responseCode" INTEGER, "lastError" TEXT, "deliveredAt" TIMESTAMP(3), ' +
    '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id") );',
  'CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");',
  'CREATE UNIQUE INDEX "ApiKey_hash_key" ON "ApiKey"("hash");',
  'CREATE INDEX "ApiKey_workspaceId_createdAt_idx" ON "ApiKey"("workspaceId", "createdAt");',
  'CREATE INDEX "WebhookEndpoint_workspaceId_idx" ON "WebhookEndpoint"("workspaceId");',
  'CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");',
  'CREATE INDEX "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");',
  'CREATE INDEX "WebhookDelivery_workspaceId_createdAt_idx" ON "WebhookDelivery"("workspaceId", "createdAt");',
  'CREATE UNIQUE INDEX "WebhookDelivery_endpointId_eventId_key" ON "WebhookDelivery"("endpointId", "eventId");',
  'ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
  'ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
];

const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-27 api keys and webhooks migration", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const sql = raw.toString("utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-27)", () => {
    const creates = code.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^(;]*/gi) ?? [];
    expect(creates).toHaveLength(11); // three tables, eight indexes
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /i);
    expect(code).not.toMatch(/ADD COLUMN/i);

    const blocks = code.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(5);
    expect((code.match(/FOREIGN KEY/g) ?? []).length).toBe(5);
    for (const [table, name, col, ref, onDelete] of [
      ["ApiKey", "ApiKey_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      // Ruling 2: a key dies with its creator.
      ["ApiKey", "ApiKey_createdById_fkey", "createdById", "User", "CASCADE"],
      ["WebhookEndpoint", "WebhookEndpoint_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["WebhookEndpoint", "WebhookEndpoint_createdById_fkey", "createdById", "User", "SET NULL"],
      ["WebhookDelivery", "WebhookDelivery_endpointId_fkey", "endpointId", "WebhookEndpoint", "CASCADE"],
    ]) {
      const block = blocks.find((b) => b.includes(`"${name}"`));
      expect(block).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${col}") REFERENCES "${ref}"("id") ON DELETE ${onDelete} ON UPDATE CASCADE;`,
      );
      expect(block).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;/);
    }

    const statementsOnly = code.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL)/g, "");
    for (const bad of [/\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i, /ALTER COLUMN/i, /\bTYPE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i]) {
      expect({ bad: String(bad), hit: bad.test(statementsOnly) }).toEqual({ bad: String(bad), hit: false });
    }

    // After SP-26 and every pinned predecessor (relative order, not adjacency).
    expect(FOLDER.slice(0, 14) > "20261118120000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders).toContain(FOLDER);
    for (const before of Object.keys(PINNED)) {
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
    expect((code.match(/^SET /gm) ?? []).length).toBe(1);
  });

  it.each(Object.entries(PINNED))("the earlier %s file is unchanged (sha256)", (folder, sha) => {
    expect(lfSha(readFileSync(join(MIGRATIONS, folder, "migration.sql")))).toBe(sha);
  });

  it("schema.prisma declares the SP-27 models as the plan names them", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
    const block = (name: string) => schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
    const key = block("ApiKey");
    expect(key).toMatch(/prefix\s+String\s+@unique/);
    expect(key).toMatch(/hash\s+String\s+@unique/);
    expect(key).toMatch(/scopes\s+Json/);
    expect(key).toMatch(/createdBy\s+User\s+@relation\("ApiKeyCreatedBy", fields: \[createdById\], references: \[id\], onDelete: Cascade\)/);
    expect(key).toMatch(/@@index\(\[workspaceId, createdAt\]\)/);
    const ep = block("WebhookEndpoint");
    expect(ep).toMatch(/events\s+String\[\]/);
    expect(ep).toMatch(/secretEnc\s+String/);
    expect(ep).toMatch(/onDelete: SetNull/);
    const del = block("WebhookDelivery");
    expect(del).toMatch(/@@unique\(\[endpointId, eventId\]\)/);
    expect(del).toMatch(/@@index\(\[status, nextAttemptAt\]\)/);
    // OAuth is deferred (R6): none of its tables or columns exist yet.
    expect(schema).not.toMatch(/model OAuth(Client|Code|Grant) /);
    expect(schema).not.toMatch(/aiToolsEnabled|aiToolsBlockedAt/);
  });
});
