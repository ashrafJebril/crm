import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261113120000_campaign_recipients";
/** sha256 of the file as applied in production (LF line endings, as committed). */
const APPLIED_SHA256 = "05a78c6094555cbfda206940f9cf94001f89c7e924d49461c23a195e4173de6c";

describe("SP-12 campaign recipients migration", () => {
  const sql = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"), "utf8");
  // Comments are ignored so prose never trips the keyword checks.
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named", () => {
    // Every CREATE is guarded.
    const creates = code.match(/\bCREATE\b[^;]*/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const c of creates) expect(c).toMatch(/IF NOT EXISTS/i);

    // Every FK sits in a DO $$ … duplicate_object block.
    const fks = code.match(/ADD CONSTRAINT[^;]*FOREIGN KEY/gi) ?? [];
    expect(fks).toHaveLength(4);
    const blocks = code.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(4);
    for (const b of blocks) {
      expect(b).toMatch(/FOREIGN KEY/);
      expect(b).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;/);
    }
    const outside = blocks.reduce((s, b) => s.replace(b, ""), code);
    expect(outside).not.toMatch(/FOREIGN KEY/i);

    // Exact Prisma names.
    for (const name of [
      "CampaignRecipient_pkey",
      "CampaignRecipient_workspaceId_fkey",
      "CampaignRecipient_campaignId_fkey",
      "CampaignRecipient_contactId_fkey",
      "CampaignRecipient_channelId_fkey",
      "CampaignRecipient_campaignId_phone_key",
      "CampaignRecipient_campaignId_status_id_idx",
      "CampaignRecipient_campaignId_id_idx",
      "CampaignRecipient_workspaceId_messageId_idx",
      "CampaignRecipient_channelId_phone_idx",
      "CampaignRecipient_contactId_idx",
    ]) {
      expect(code).toContain(`"${name}"`);
    }
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "CampaignRecipient_campaignId_phone_key" ON "CampaignRecipient"\("campaignId", "phone"\)/);
    expect(code).toMatch(/"CampaignRecipient_campaignId_status_id_idx" ON "CampaignRecipient"\("campaignId", "status", "id"\)/);

    // FK actions.
    expect(code).toMatch(/"workspaceId"\) REFERENCES "Workspace"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/);
    expect(code).toMatch(/"campaignId"\) REFERENCES "Campaign"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/);
    expect(code).toMatch(/"contactId"\) REFERENCES "Contact"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/);
    expect(code).toMatch(/"channelId"\) REFERENCES "Channel"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/);

    // Nothing destructive or rewriting.
    for (const bad of [/\bDROP\b/i, /\bUPDATE\s+"/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /ALTER COLUMN/i, /\bTYPE\b/i, /\bINSERT\b/i]) {
      expect(code).not.toMatch(bad);
    }

    // Campaign columns are additive with defaults.
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "recipientTracking" BOOLEAN NOT NULL DEFAULT false/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "recipientsSyncedAt" TIMESTAMP\(3\)/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "recipientSyncSkip" INTEGER NOT NULL DEFAULT 0/);
    const addCols = code.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(addCols).toHaveLength(3);
    for (const a of addCols) expect(a).toMatch(/IF NOT EXISTS/i);

    // updatedAt has no DB default (Prisma @updatedAt).
    expect(code).toMatch(/"updatedAt" TIMESTAMP\(3\) NOT NULL,/);
    expect(code).toMatch(/"status" TEXT NOT NULL DEFAULT 'queued'/);

    // Ordered after the last applied migration, and the newest folder.
    expect(FOLDER.slice(0, 14) > "20261112120000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    // SP-13 adds 20261114120000 after it; nothing may slip in before it.
    expect(folders[folders.indexOf(FOLDER) - 1]).toBe("20261112120000_channels");
  });

  it("the applied SP-12 migration file is pinned (sha256 Prisma checks on deploy)", () => {
    const bytes = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(APPLIED_SHA256);
  });

  it("schema.prisma declares the same model and Campaign columns", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8");
    const model = schema.match(/model CampaignRecipient \{[\s\S]*?\n\}/)?.[0] ?? "";
    for (const line of [
      "@@unique([campaignId, phone])",
      "@@index([campaignId, status, id])",
      "@@index([campaignId, id])",
      "@@index([workspaceId, messageId])",
      "@@index([channelId, phone])",
      "@@index([contactId])",
    ]) {
      expect(model).toContain(line);
    }
    expect(schema).toMatch(/recipientTracking\s+Boolean\s+@default\(false\)/);
    expect(schema).toMatch(/recipientSyncSkip\s+Int\s+@default\(0\)/);
  });
});
