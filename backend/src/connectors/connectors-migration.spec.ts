import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261117170000_connectors_gallery";
/** sha256 of the earlier files that sort before this one (LF, as committed).
 *  Never edit them. Ordering is relative, not adjacency. */
const PINNED: Record<string, string> = {
  "20261116120000_support_tickets": "555000f79d7d764bf69429a0bd56b52b4893802e56a5e4cc01da949ef7b6e22c",
  "20261116130000_bookings_catalog": "913dad261ab4f163019f2d3c3c1b8a8bdf98ca08e233bcad489aa373aef08875",
  "20261116140000_insights_home": "a203771a9711c07a15bd26ab41635af9e2177ac0cdb767b434242d9d36ba9013",
  "20261117120000_knowledge_upgrade": "463dcac144c1c369fd40479007ec824a21e766c34238d19ab2705a3db6c4a1db",
  "20261117130000_agent_config": "0389880cc4dde498652acd083596b9e5e89f303e575e275e646784fde617f5ce",
  "20261117140000_copilot": "389bd9bd9db4b739af9be3a2975a8272767dc09357611082474c02ff2a412f13",
  "20261117150000_lifecycle_messages": "f77f8fd558338996675b18b4d757ebb8117ceb512b364fd3b3d009315a77ce34",
  "20261117160000_skills_gallery": "28374cfb0b9d1f7c9658e59253484ec2510ac963833c62ba78d2087b8d39d4f2",
};

const T = (name: string, cols: string) => `CREATE TABLE "${name}" ( ${cols}, CONSTRAINT "${name}_pkey" PRIMARY KEY ("id") );`;
/**
 * What `prisma migrate diff` (Prisma 5.22) yields for the SP-23 models,
 * whitespace-collapsed. Hand-derived in Prisma's output format; no
 * `prisma migrate` command was run (ruling 14). The file must equal it apart
 * from `IF NOT EXISTS`, the duplicate_object wrappers, lock_timeout and order.
 */
const PRISMA_DIFF = [
  T(
    "Connector",
    '"id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "provider" TEXT NOT NULL, "name" TEXT NOT NULL, "authKind" TEXT NOT NULL, ' +
      '"status" TEXT NOT NULL DEFAULT \'pending\', "statusReason" TEXT, "serverUrl" TEXT NOT NULL, "tokenEnc" TEXT, ' +
      '"tokenExpiresAt" TIMESTAMP(3), "tokenVersion" INTEGER NOT NULL DEFAULT 0, "refreshFailures" INTEGER NOT NULL DEFAULT 0, ' +
      '"lastRefreshAt" TIMESTAMP(3), "headersEnc" TEXT, "oauthClientEnc" TEXT, "oauthMeta" JSONB, "oauthPendingEnc" TEXT, ' +
      '"oauthPendingExpiresAt" TIMESTAMP(3), "tools" JSONB NOT NULL DEFAULT \'[]\', "toolsScannedAt" TIMESTAMP(3), ' +
      '"accountLabel" TEXT, "lServerId" TEXT, "agentBound" BOOLEAN NOT NULL DEFAULT false, "proxyTokenPrefix" TEXT, ' +
      '"proxyTokenHash" TEXT, "sync" JSONB NOT NULL DEFAULT \'{}\', "connectedById" TEXT, "connectedAt" TIMESTAMP(3), ' +
      '"disconnectedAt" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
      '"updatedAt" TIMESTAMP(3) NOT NULL',
  ),
  T(
    "ConnectorCall",
    '"id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "connectorId" TEXT NOT NULL, "tool" TEXT NOT NULL, "kind" TEXT NOT NULL, ' +
      '"outcome" TEXT NOT NULL, "errorCode" TEXT, "durationMs" INTEGER NOT NULL, "source" TEXT NOT NULL DEFAULT \'agent\', ' +
      '"at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
  ),
  T(
    "ConnectorSyncLink",
    '"id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "connectorId" TEXT NOT NULL, "kind" TEXT NOT NULL, "externalId" TEXT NOT NULL, ' +
      '"localId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL',
  ),
  T(
    "ConnectorSyncRun",
    '"id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "connectorId" TEXT NOT NULL, "kind" TEXT NOT NULL, ' +
      '"added" INTEGER NOT NULL DEFAULT 0, "matched" INTEGER NOT NULL DEFAULT 0, "failed" INTEGER NOT NULL DEFAULT 0, "error" TEXT, ' +
      '"startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3)',
  ),
  'CREATE UNIQUE INDEX "Connector_proxyTokenPrefix_key" ON "Connector"("proxyTokenPrefix");',
  'CREATE INDEX "Connector_workspaceId_provider_idx" ON "Connector"("workspaceId", "provider");',
  'CREATE INDEX "Connector_status_tokenExpiresAt_idx" ON "Connector"("status", "tokenExpiresAt");',
  'CREATE INDEX "ConnectorCall_connectorId_at_idx" ON "ConnectorCall"("connectorId", "at");',
  'CREATE INDEX "ConnectorCall_workspaceId_at_idx" ON "ConnectorCall"("workspaceId", "at");',
  'CREATE INDEX "ConnectorSyncLink_workspaceId_idx" ON "ConnectorSyncLink"("workspaceId");',
  'CREATE UNIQUE INDEX "ConnectorSyncLink_connectorId_kind_externalId_key" ON "ConnectorSyncLink"("connectorId", "kind", "externalId");',
  'CREATE INDEX "ConnectorSyncRun_connectorId_startedAt_idx" ON "ConnectorSyncRun"("connectorId", "startedAt");',
  ...(
    [
      ["Connector", "Connector_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["Connector", "Connector_connectedById_fkey", "connectedById", "User", "SET NULL"],
      ["ConnectorCall", "ConnectorCall_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["ConnectorCall", "ConnectorCall_connectorId_fkey", "connectorId", "Connector", "CASCADE"],
      ["ConnectorSyncLink", "ConnectorSyncLink_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["ConnectorSyncLink", "ConnectorSyncLink_connectorId_fkey", "connectorId", "Connector", "CASCADE"],
      ["ConnectorSyncRun", "ConnectorSyncRun_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["ConnectorSyncRun", "ConnectorSyncRun_connectorId_fkey", "connectorId", "Connector", "CASCADE"],
    ] as const
  ).map(
    ([t, n, c, r, d]) => `ALTER TABLE "${t}" ADD CONSTRAINT "${n}" FOREIGN KEY ("${c}") REFERENCES "${r}"("id") ON DELETE ${d} ON UPDATE CASCADE;`,
  ),
];

const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-23 connectors gallery migration", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const code = raw
    .toString("utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-23)", () => {
    const creates = code.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^(;]*/gi) ?? [];
    expect(creates).toHaveLength(12); // four tables, eight indexes
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /i);
    const blocks = code.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(8);
    for (const b of blocks) expect(b).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;/);
    // The only ALTERs are the FK adds, each inside its own DO block.
    const outside = code.replace(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g, "");
    expect(outside).not.toMatch(/\bALTER\b/i);
    const statementsOnly = code.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL)/g, "");
    for (const bad of [/\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i, /ALTER COLUMN/i, /\bTYPE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i]) {
      expect({ bad: String(bad), hit: bad.test(statementsOnly) }).toEqual({ bad: String(bad), hit: false });
    }
    expect(FOLDER.slice(0, 14) > "20261117160000").toBe(true);
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
  });

  it.each(Object.entries(PINNED))("the earlier %s file is unchanged (sha256)", (folder, sha) => {
    expect(lfSha(readFileSync(join(MIGRATIONS, folder, "migration.sql")))).toBe(sha);
  });

  it("schema.prisma declares the SP-23 models as the plan names them", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
    const block = (name: string) => schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
    const c = block("Connector");
    expect(c).toMatch(/proxyTokenPrefix\s+String\?\s+@unique/);
    expect(c).toMatch(/tools\s+Json\s+@default\("\[\]"\)/);
    expect(c).toMatch(/@@index\(\[status, tokenExpiresAt\]\)/);
    expect(block("ConnectorCall")).toMatch(/@@index\(\[connectorId, at\]\)/);
    expect(block("ConnectorSyncLink")).toMatch(/@@unique\(\[connectorId, kind, externalId\]\)/);
    expect(block("ConnectorSyncRun")).toMatch(/@@index\(\[connectorId, startedAt\]\)/);
  });
});
