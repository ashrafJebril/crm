import { execFileSync } from "child_process";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261114120000_campaign_sending";
const SP12 = "20261113120000_campaign_recipients";

describe("SP-13 campaign sending migration", () => {
  const sql = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"), "utf8");
  // Comments are ignored so prose never trips the keyword checks.
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-13)", () => {
    // Every CREATE and ADD COLUMN is guarded.
    const creates = code.match(/\bCREATE\b[^;]*/gi) ?? [];
    expect(creates.length).toBeGreaterThanOrEqual(8);
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/i);
    const addCols = code.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(addCols).toHaveLength(14);
    for (const a of addCols) expect(a).toMatch(/^ADD COLUMN IF NOT EXISTS/i);

    // Every FK sits in a DO $$ … duplicate_object block.
    const fks = code.match(/ADD CONSTRAINT[^;]*FOREIGN KEY/gi) ?? [];
    expect(fks).toHaveLength(6);
    const blocks = code.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(6);
    for (const b of blocks) {
      expect(b).toMatch(/FOREIGN KEY/);
      expect(b).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;/);
    }
    const outside = blocks.reduce((s, b) => s.replace(b, ""), code);
    expect(outside).not.toMatch(/FOREIGN KEY/i);
    expect(outside).not.toMatch(/ADD CONSTRAINT/i);

    // Exact Prisma names, each with its exact definition.
    const named: Array<[string, RegExp]> = [
      ["CampaignBroadcast_pkey", /CONSTRAINT "CampaignBroadcast_pkey" PRIMARY KEY \("id"\)/],
      [
        "CampaignBroadcast_workspaceId_fkey",
        /"CampaignBroadcast_workspaceId_fkey"\s+FOREIGN KEY \("workspaceId"\) REFERENCES "Workspace"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/,
      ],
      [
        "CampaignBroadcast_campaignId_fkey",
        /"CampaignBroadcast_campaignId_fkey"\s+FOREIGN KEY \("campaignId"\) REFERENCES "Campaign"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/,
      ],
      [
        "CampaignBroadcast_channelId_fkey",
        /"CampaignBroadcast_channelId_fkey"\s+FOREIGN KEY \("channelId"\) REFERENCES "Channel"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
      ],
      [
        "CampaignBroadcast_campaignId_partitionKey_key",
        /CREATE UNIQUE INDEX IF NOT EXISTS "CampaignBroadcast_campaignId_partitionKey_key" ON "CampaignBroadcast"\("campaignId", "partitionKey"\)/,
      ],
      ["CampaignBroadcast_workspaceId_idx", /INDEX IF NOT EXISTS "CampaignBroadcast_workspaceId_idx" ON "CampaignBroadcast"\("workspaceId"\)/],
      [
        "CampaignBroadcast_zernioBroadcastId_idx",
        /INDEX IF NOT EXISTS "CampaignBroadcast_zernioBroadcastId_idx" ON "CampaignBroadcast"\("zernioBroadcastId"\)/,
      ],
      ["CampaignBroadcast_channelId_idx", /INDEX IF NOT EXISTS "CampaignBroadcast_channelId_idx" ON "CampaignBroadcast"\("channelId"\)/],
      [
        "CampaignRecipient_broadcastId_fkey",
        /"CampaignRecipient_broadcastId_fkey"\s+FOREIGN KEY \("broadcastId"\) REFERENCES "CampaignBroadcast"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
      ],
      [
        "CampaignRecipient_broadcastId_status_id_idx",
        /INDEX IF NOT EXISTS "CampaignRecipient_broadcastId_status_id_idx" ON "CampaignRecipient"\("broadcastId", "status", "id"\)/,
      ],
      [
        "CampaignRecipient_campaignId_channelId_status_idx",
        /INDEX IF NOT EXISTS "CampaignRecipient_campaignId_channelId_status_idx" ON "CampaignRecipient"\("campaignId", "channelId", "status"\)/,
      ],
      [
        "Campaign_headerMediaId_fkey",
        /"Campaign_headerMediaId_fkey"\s+FOREIGN KEY \("headerMediaId"\) REFERENCES "Media"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
      ],
      [
        "Campaign_status_launchHeartbeatAt_idx",
        /INDEX IF NOT EXISTS "Campaign_status_launchHeartbeatAt_idx" ON "Campaign"\("status", "launchHeartbeatAt"\)/,
      ],
      [
        "Template_headerMediaId_fkey",
        /"Template_headerMediaId_fkey"\s+FOREIGN KEY \("headerMediaId"\) REFERENCES "Media"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
      ],
    ];
    for (const [name, def] of named) {
      expect(code).toContain(`"${name}"`);
      expect(code).toMatch(def);
    }

    // Nothing destructive or rewriting.
    for (const bad of [/\bDROP\b/i, /\bUPDATE\s+"/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /ALTER COLUMN/i, /\bTYPE\b/i, /\bINSERT\b/i]) {
      expect(code).not.toMatch(bad);
    }

    // New columns: nullable, or NOT NULL with a default.
    for (const col of [
      /"senderChannelIds" TEXT\[\] NOT NULL DEFAULT ARRAY\[\]::TEXT\[\]/,
      /"varMap" JSONB(,|\s*;|\s*$)/m,
      /"headerMediaId" TEXT(,|;)/,
      /"launchStage" TEXT(,|;)/,
      /"launchHeartbeatAt" TIMESTAMP\(3\)(,|;)/,
      /"launchAttempts" INTEGER NOT NULL DEFAULT 0/,
      /"launchedById" TEXT(,|;)/,
      /"planCompletedAt" TIMESTAMP\(3\)(,|;)/,
      /"cancelRequestedAt" TIMESTAMP\(3\)(,|;)/,
      /"sendTransport" TEXT(,|;)/,
      /"broadcastId" TEXT(,|;)/,
      /"templateParams" JSONB(,|;)/,
      /"sendAttemptedAt" TIMESTAMP\(3\)(,|;)/,
    ]) {
      expect(code).toMatch(col);
    }
    for (const a of addCols) {
      if (/NOT NULL/i.test(a)) expect(a).toMatch(/DEFAULT/i);
    }
    // Inside the new table, every NOT NULL column except the PK, the FKs it
    // needs and Prisma-managed values has a default.
    const table = code.match(/CREATE TABLE IF NOT EXISTS "CampaignBroadcast" \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(table).not.toBe("");
    expect(table).toMatch(/"variables" JSONB NOT NULL,/);
    expect(table).toMatch(/"updatedAt" TIMESTAMP\(3\) NOT NULL,/);
    expect(table).toMatch(/"stage" TEXT NOT NULL DEFAULT 'pending'/);
    expect(table).toMatch(/"recipientCount" INTEGER NOT NULL DEFAULT 0/);
    expect(table).toMatch(/"recipientSyncSkip" INTEGER NOT NULL DEFAULT 0/);
    expect(table).toMatch(/"createdAt" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);

    // Ordered after SP-12's migration, and the newest folder.
    expect(FOLDER.slice(0, 14) > "20261113120000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders.at(-1)).toBe(FOLDER);
    expect(folders.at(-2)).toBe(SP12);
  });

  it("the SP-12 migration file is byte-identical to HEAD", () => {
    const rel = `backend/prisma/migrations/${SP12}/migration.sql`;
    const root = join(__dirname, "..", "..", "..");
    const head = execFileSync("git", ["show", `HEAD:${rel}`], { cwd: root });
    const disk = readFileSync(join(MIGRATIONS, SP12, "migration.sql"));
    expect(Buffer.compare(disk, head)).toBe(0);
  });

  it("schema.prisma declares the same model, columns and indexes", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8");
    const model = schema.match(/model CampaignBroadcast \{[\s\S]*?\n\}/)?.[0] ?? "";
    for (const line of ["@@unique([campaignId, partitionKey])", "@@index([workspaceId])", "@@index([zernioBroadcastId])", "@@index([channelId])"]) {
      expect(model).toContain(line);
    }
    const recipient = schema.match(/model CampaignRecipient \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(recipient).toContain("@@index([broadcastId, status, id])");
    expect(recipient).toContain("@@index([campaignId, channelId, status])");
    const campaign = schema.match(/model Campaign \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(campaign).toContain("@@index([status, launchHeartbeatAt])");
    expect(campaign).toMatch(/senderChannelIds\s+String\[\]\s+@default\(\[\]\)/);
    expect(campaign).toMatch(/launchAttempts\s+Int\s+@default\(0\)/);
    expect(schema).toMatch(/model Template \{[\s\S]*?headerMediaId\s+String\?[\s\S]*?\n\}/);
  });
});
