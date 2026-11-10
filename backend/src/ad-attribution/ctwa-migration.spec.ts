import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261115120000_ctwa_attribution";
/** sha256 of the applied files (LF, as committed). Applied in production: never edit them. */
const PINNED: Record<string, string> = {
  "20261114130000_contact_workspace_id_index": "af6730c4d81da99a945436a6ae8b08d571d23cef48d58ec026015c4842db50ef",
  "20261114140000_number_template_health": "24d05fd010ec625a3a0dfe1fde619d1364905fb2f3c7beb12266d4e833022dc0",
};

const TABLES = ["AdSource", "AdReferral", "AdSpendDaily", "MetaAdsConnection", "MetaLead"];

const INDEXES: Array<[string, string, string, boolean]> = [
  ["AdSource_workspaceId_lastReferredAt_idx", "AdSource", '"workspaceId", "lastReferredAt"', false],
  ["AdSource_workspaceId_adAccountId_idx", "AdSource", '"workspaceId", "adAccountId"', false],
  ["AdSource_workspaceId_sourceType_sourceId_key", "AdSource", '"workspaceId", "sourceType", "sourceId"', true],
  ["AdReferral_messageId_key", "AdReferral", '"messageId"', true],
  ["AdReferral_workspaceId_adSourceId_referredAt_idx", "AdReferral", '"workspaceId", "adSourceId", "referredAt"', false],
  ["AdReferral_workspaceId_referredAt_idx", "AdReferral", '"workspaceId", "referredAt"', false],
  ["AdReferral_conversationId_idx", "AdReferral", '"conversationId"', false],
  ["AdSpendDaily_workspaceId_adAccountId_date_idx", "AdSpendDaily", '"workspaceId", "adAccountId", "date"', false],
  ["AdSpendDaily_adSourceId_date_key", "AdSpendDaily", '"adSourceId", "date"', true],
  ["MetaAdsConnection_workspaceId_key", "MetaAdsConnection", '"workspaceId"', true],
  ["MetaAdsConnection_status_syncAttemptedAt_idx", "MetaAdsConnection", '"status", "syncAttemptedAt"', false],
  ["MetaLead_workspaceId_contactId_idx", "MetaLead", '"workspaceId", "contactId"', false],
  ["MetaLead_workspaceId_leadgenId_key", "MetaLead", '"workspaceId", "leadgenId"', true],
  ["Conversation_workspaceId_adSourceId_idx", "Conversation", '"workspaceId", "adSourceId"', false],
];

const FKS: Array<[string, string, string, string, "CASCADE" | "SET NULL"]> = [
  ["Conversation_adSourceId_fkey", "Conversation", "adSourceId", "AdSource", "SET NULL"],
  ["AdSource_workspaceId_fkey", "AdSource", "workspaceId", "Workspace", "CASCADE"],
  ["AdSource_mediaId_fkey", "AdSource", "mediaId", "Media", "SET NULL"],
  ["AdReferral_workspaceId_fkey", "AdReferral", "workspaceId", "Workspace", "CASCADE"],
  ["AdReferral_adSourceId_fkey", "AdReferral", "adSourceId", "AdSource", "CASCADE"],
  ["AdReferral_conversationId_fkey", "AdReferral", "conversationId", "Conversation", "CASCADE"],
  ["AdReferral_messageId_fkey", "AdReferral", "messageId", "Message", "CASCADE"],
  ["AdSpendDaily_workspaceId_fkey", "AdSpendDaily", "workspaceId", "Workspace", "CASCADE"],
  ["AdSpendDaily_adSourceId_fkey", "AdSpendDaily", "adSourceId", "AdSource", "CASCADE"],
  ["MetaAdsConnection_workspaceId_fkey", "MetaAdsConnection", "workspaceId", "Workspace", "CASCADE"],
  ["MetaAdsConnection_connectedById_fkey", "MetaAdsConnection", "connectedById", "User", "SET NULL"],
  ["MetaLead_workspaceId_fkey", "MetaLead", "workspaceId", "Workspace", "CASCADE"],
  ["MetaLead_adSourceId_fkey", "MetaLead", "adSourceId", "AdSource", "SET NULL"],
  ["MetaLead_contactId_fkey", "MetaLead", "contactId", "Contact", "CASCADE"],
];

/**
 * `prisma migrate diff --from-schema-datamodel <9c8b5da schema> --to-schema-datamodel
 * prisma/schema.prisma --script` (Prisma 5.22.0, run 2026-11-10, no DB), as the
 * statement skeleton: each statement's leading words in order. The file must
 * equal the full diff apart from `IF NOT EXISTS` and the DO wrappers; the
 * statement-level comparison below checks that.
 */
const PRISMA_DIFF_HEADS = [
  'ALTER TABLE "Conversation" ADD COLUMN "adReferredAt" TIMESTAMP(3), ADD COLUMN "adSourceId" TEXT;',
  ...TABLES.map((t) => `CREATE TABLE "${t}"`),
  ...[
    "AdSource_workspaceId_lastReferredAt_idx",
    "AdSource_workspaceId_adAccountId_idx",
    "AdSource_workspaceId_sourceType_sourceId_key",
    "AdReferral_messageId_key",
    "AdReferral_workspaceId_adSourceId_referredAt_idx",
    "AdReferral_workspaceId_referredAt_idx",
    "AdReferral_conversationId_idx",
    "AdSpendDaily_workspaceId_adAccountId_date_idx",
    "AdSpendDaily_adSourceId_date_key",
    "MetaAdsConnection_workspaceId_key",
    "MetaAdsConnection_status_syncAttemptedAt_idx",
    "MetaLead_workspaceId_contactId_idx",
    "MetaLead_workspaceId_leadgenId_key",
    "Conversation_workspaceId_adSourceId_idx",
  ].map((n) => `INDEX "${n}"`),
  ...FKS.map(([n]) => `CONSTRAINT "${n}"`),
];

describe("SP-15 ctwa attribution migration", () => {
  const sql = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"), "utf8");
  // Comments are ignored so prose never trips the keyword checks.
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-15)", () => {
    // Every CREATE and ADD COLUMN is guarded.
    const creates = code.match(/\bCREATE\b[^;]*/gi) ?? [];
    expect(creates).toHaveLength(TABLES.length + INDEXES.length);
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/i);
    const addCols = code.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(addCols).toHaveLength(2);
    for (const a of addCols) expect(a).toMatch(/^ADD COLUMN IF NOT EXISTS/i);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "adSourceId" TEXT;/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "adReferredAt" TIMESTAMP\(3\),/);

    // Every FK sits in a DO $$ … duplicate_object block.
    const fks = code.match(/ADD CONSTRAINT[^;]*FOREIGN KEY/gi) ?? [];
    expect(fks).toHaveLength(FKS.length);
    const blocks = code.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(FKS.length);
    for (const b of blocks) {
      expect(b).toMatch(/FOREIGN KEY/);
      expect(b).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;/);
    }
    const outside = blocks.reduce((s, b) => s.replace(b, ""), code);
    expect(outside).not.toMatch(/FOREIGN KEY/i);
    expect(outside).not.toMatch(/ADD CONSTRAINT/i);

    // Exact Prisma names, each with its exact definition.
    for (const t of TABLES) {
      expect(code).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS "${t}" \\(`));
      expect(code).toContain(`CONSTRAINT "${t}_pkey" PRIMARY KEY ("id")`);
    }
    for (const [name, table, cols, unique] of INDEXES) {
      expect(code).toContain(`CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${name}" ON "${table}"(${cols});`);
    }
    for (const [name, table, col, ref, onDelete] of FKS) {
      expect(code).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${col}") REFERENCES "${ref}"("id") ON DELETE ${onDelete} ON UPDATE CASCADE;`,
      );
    }
    // Column shapes the plan names.
    expect(code).toMatch(/"firstTouch" BOOLEAN NOT NULL DEFAULT false/);
    expect(code).toMatch(/"date" DATE NOT NULL/);
    expect(code).toMatch(/"spend" DECIMAL\(14,4\) NOT NULL/);
    expect(code).toMatch(/"status" TEXT NOT NULL DEFAULT 'pending'/);
    expect(code).toMatch(/"leadCheckpoints" JSONB,/);
    expect(code).toMatch(/"fieldData" JSONB NOT NULL/);
    expect(code).toMatch(/"importedAt" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    expect(code).toMatch(/"updatedAt" TIMESTAMP\(3\) NOT NULL,/);

    // Nothing destructive or rewriting (`ON UPDATE CASCADE` is a FK action, not a statement).
    for (const bad of [
      /\bDROP\b/i,
      /\bUPDATE\s+"/i,
      /^\s*UPDATE\b/im,
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
      /ALTER COLUMN/i,
      /\bTYPE\b/i,
      /\bINSERT\b/i,
    ]) {
      expect(code).not.toMatch(bad);
    }
    // The only existing table touched is Conversation, with nullable columns.
    const alters = code.match(/ALTER TABLE "(\w+)"/g) ?? [];
    for (const a of alters) {
      const t = a.match(/"(\w+)"/)![1];
      expect([...TABLES, "Conversation"]).toContain(t);
    }
    expect(code).not.toMatch(/ADD COLUMN IF NOT EXISTS "[^"]+" [^,;]*NOT NULL/);

    // Ordered after the last applied migration.
    expect(FOLDER.slice(0, 14) > "20261114140000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders[folders.indexOf(FOLDER) - 1]).toBe("20261114140000_number_template_health");
  });

  it("equals prisma migrate diff apart from IF NOT EXISTS and the DO wrappers", () => {
    const statements = code
      .replace(/DO \$\$ BEGIN\s*/g, "")
      .replace(/EXCEPTION WHEN duplicate_object THEN NULL;\s*END \$\$;/g, "")
      .replace(/IF NOT EXISTS /g, "")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((s) => `${s};`);
    expect(statements).toHaveLength(PRISMA_DIFF_HEADS.length);
    expect(statements[0]).toBe(PRISMA_DIFF_HEADS[0]);
    PRISMA_DIFF_HEADS.slice(1).forEach((head, i) => expect(statements[i + 1]).toContain(head));
  });

  it.each(Object.entries(PINNED))("the applied %s file is unchanged (sha256)", (folder, sha) => {
    const bytes = readFileSync(join(MIGRATIONS, folder, "migration.sql"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
  });

  it("schema.prisma declares the SP-15 models and the Conversation columns", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8");
    for (const t of TABLES) expect(schema).toMatch(new RegExp(`\\nmodel ${t} \\{`));
    const conv = schema.match(/model Conversation \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(conv).toMatch(/adSourceId\s+String\?/);
    expect(conv).toMatch(/adReferredAt\s+DateTime\?/);
    expect(conv).toContain("@@index([workspaceId, adSourceId])");
  });
});
