import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261116120000_support_tickets";
/** sha256 of applied files (LF, as committed). Applied in production: never edit them. */
const PINNED: Record<string, string> = {
  "20261115120000_ctwa_attribution": "9aa652fdfe1bc8ab5311389f83d972dd014bef39f536c1dee2243502611eabec",
  "20261115130000_smart_audiences": "610081cbf5b7275c45447b830bafb7303aa286edb062de5aeaae26962d0cc083",
  "20261115140000_media_ai_details": "f2f306360781f306d7cf7d7181693576ef12706847c2298bf3fcfedad2cb4334",
};

/**
 * What `prisma migrate diff --from-schema-datamodel <ab353a4 schema>
 * --to-schema-datamodel prisma/schema.prisma --script` printed for this change
 * (run 2026-11-16, no DB), whitespace-collapsed. The file must equal it apart
 * from `IF NOT EXISTS`, the duplicate_object wrappers and the trigger block.
 */
const PRISMA_DIFF = [
  'ALTER TABLE "Ticket" ADD COLUMN "category" TEXT, ADD COLUMN "priority" TEXT NOT NULL DEFAULT \'normal\', ADD COLUMN "slaDueAt" TIMESTAMP(3);',
  'CREATE TABLE "TicketAttachment" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "ticketId" TEXT NOT NULL, "mediaId" TEXT NOT NULL, ' +
    '"source" TEXT NOT NULL, "messageId" TEXT, "addedById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
    'CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id") );',
  'CREATE INDEX "TicketAttachment_workspaceId_idx" ON "TicketAttachment"("workspaceId");',
  'CREATE INDEX "TicketAttachment_mediaId_idx" ON "TicketAttachment"("mediaId");',
  'CREATE UNIQUE INDEX "TicketAttachment_ticketId_mediaId_key" ON "TicketAttachment"("ticketId", "mediaId");',
  'CREATE INDEX "Ticket_workspaceId_slaDueAt_idx" ON "Ticket"("workspaceId", "slaDueAt");',
  'ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
];

/** Hash as committed (LF), whatever the checkout's autocrlf did. */
const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-09 support tickets migration", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const sql = raw.toString("utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const triggerAt = code.indexOf('CREATE OR REPLACE FUNCTION "ticket_sla_due_at"()');
  const ddl = code.slice(0, triggerAt);
  const trigger = code.slice(triggerAt);

  it("migration is additive, idempotent and Prisma-named (SP-09)", () => {
    // Every CREATE TABLE, ADD COLUMN and CREATE INDEX is IF NOT EXISTS.
    const creates = ddl.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^(;]*/gi) ?? [];
    expect(creates).toHaveLength(5); // one table, four indexes
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /i);
    const addCols = ddl.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(addCols).toHaveLength(3);
    for (const a of addCols) expect(a).toMatch(/^ADD COLUMN IF NOT EXISTS/i);

    // Exact names.
    expect(ddl).toMatch(/ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'normal'/);
    expect(ddl).toMatch(/ADD COLUMN IF NOT EXISTS "category" TEXT,/);
    expect(ddl).toMatch(/ADD COLUMN IF NOT EXISTS "slaDueAt" TIMESTAMP\(3\);/);
    for (const name of [
      '"TicketAttachment_pkey"',
      '"TicketAttachment_ticketId_mediaId_key"',
      '"TicketAttachment_workspaceId_idx"',
      '"TicketAttachment_mediaId_idx"',
      '"Ticket_workspaceId_slaDueAt_idx"',
    ]) {
      expect(ddl).toContain(name);
    }

    // Every FK sits in its own duplicate_object block, with the plan's actions.
    const fks = [
      ["TicketAttachment_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["TicketAttachment_ticketId_fkey", "ticketId", "Ticket", "CASCADE"],
      ["TicketAttachment_mediaId_fkey", "mediaId", "Media", "CASCADE"],
      ["TicketAttachment_addedById_fkey", "addedById", "User", "SET NULL"],
    ];
    const blocks = ddl.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(fks.length);
    expect((ddl.match(/FOREIGN KEY/g) ?? []).length).toBe(fks.length);
    for (const [name, col, ref, onDelete] of fks) {
      const block = blocks.find((b) => b.includes(`"${name}"`));
      expect(block).toBeDefined();
      expect(block).toContain(
        `ALTER TABLE "TicketAttachment" ADD CONSTRAINT "${name}" FOREIGN KEY ("${col}") REFERENCES "${ref}"("id") ON DELETE ${onDelete} ON UPDATE CASCADE;`,
      );
      expect(block).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;/);
    }

    // The trigger: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS + CREATE TRIGGER.
    expect(triggerAt).toBeGreaterThan(0);
    expect(trigger).toMatch(/CREATE OR REPLACE FUNCTION "ticket_sla_due_at"\(\) RETURNS trigger AS \$\$/);
    expect(trigger).toMatch(/DROP TRIGGER IF EXISTS "Ticket_sla_due_at" ON "Ticket";/);
    expect(trigger).toMatch(
      /CREATE TRIGGER "Ticket_sla_due_at"\s+BEFORE INSERT OR UPDATE OF "stageId" ON "Ticket"\s+FOR EACH ROW EXECUTE FUNCTION "ticket_sla_due_at"\(\);/,
    );
    expect(trigger.indexOf("DROP TRIGGER")).toBeLessThan(trigger.indexOf('CREATE TRIGGER "Ticket_sla_due_at"'));
    // It only writes slaDueAt (never enteredStageAt) and reads the stage's SLA.
    expect(trigger).toMatch(/NEW\."slaDueAt" := NULL;/);
    expect(trigger).toMatch(/NEW\."slaDueAt" := entered \+ make_interval\(mins => st\."slaMinutes"\);/);
    expect(trigger).not.toMatch(/NEW\."enteredStageAt"\s*:=/);
    expect(trigger).not.toMatch(/RAISE/i);

    // Nothing destructive: the only DROP is our own trigger's DROP TRIGGER IF EXISTS.
    // FK actions and the trigger's own event words are not statements.
    const statementsOnly = code
      .replace(/DROP TRIGGER IF EXISTS "Ticket_sla_due_at" ON "Ticket";/, "")
      .replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL)/g, "")
      .replace(/TG_OP = '(INSERT|UPDATE)'/g, "")
      .replace(/BEFORE INSERT OR UPDATE OF "stageId"/, "");
    for (const bad of [/\bDROP\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /ALTER COLUMN/i, /\bTYPE\b/i]) {
      expect({ bad: String(bad), hit: bad.test(statementsOnly) }).toEqual({ bad: String(bad), hit: false });
    }

    // Ordered after every applied migration (SP-17's is the latest applied).
    expect(FOLDER.slice(0, 14) > "20261115140000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders[folders.indexOf(FOLDER) - 1]).toBe("20261115140000_media_ai_details");

    // LF only (Prisma checksums the exact bytes; .gitattributes enforces it on commit).
    expect(raw.includes(Buffer.from("\r\n"))).toBe(false);
  });

  it("equals prisma migrate diff apart from IF NOT EXISTS, the DO wrappers and the trigger", () => {
    const statements = ddl
      .replace(/IF NOT EXISTS /g, "")
      .replace(/DO \$\$ BEGIN([\s\S]*?)EXCEPTION WHEN duplicate_object THEN NULL;\s*END \$\$;/g, "$1")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((s) => `${s};`);
    expect(statements).toEqual(PRISMA_DIFF);
  });

  it.each(Object.entries(PINNED))("the applied %s file is unchanged (sha256)", (folder, sha) => {
    expect(lfSha(readFileSync(join(MIGRATIONS, folder, "migration.sql")))).toBe(sha);
  });

  it("schema.prisma declares the SP-09 columns, model and index", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
    const ticket = schema.match(/model Ticket \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(ticket).toMatch(/\bpriority\s+String\s+@default\("normal"\)/);
    expect(ticket).toMatch(/\bcategory\s+String\?/);
    expect(ticket).toMatch(/\bslaDueAt\s+DateTime\?/);
    expect(ticket).toMatch(/\battachments\s+TicketAttachment\[\]/);
    expect(ticket).toMatch(/@@index\(\[workspaceId, slaDueAt\]\)/);
    const att = schema.match(/model TicketAttachment \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(att).toMatch(/@@unique\(\[ticketId, mediaId\]\)/);
    expect(att).toMatch(/onDelete: Cascade\)[\s\S]*source\s+String/);
    expect(att).toMatch(/addedBy\s+User\?\s+@relation\("TicketAttachmentAddedBy", fields: \[addedById\], references: \[id\], onDelete: SetNull\)/);
  });

  it("the SLA backfill is a separate, rerunnable script (not in the migration)", () => {
    const backfill = readFileSync(join(__dirname, "..", "..", "scripts", "backfill-ticket-sla.sql"), "utf8");
    expect(backfill).toMatch(/"slaDueAt" IS NULL/);
    expect(backfill).toMatch(/LIMIT 1000/);
    expect(backfill).toMatch(/"isTerminal" = false/);
    expect(backfill).not.toMatch(/"stageId"\s*=\s*(?!t\.)/); // never rewrites a stage
    expect(code).not.toMatch(/\bUPDATE "Ticket"/);
  });

  it("the backfill commits per batch and only touches tickets that entered their stage before a cutoff (I1, M7)", () => {
    const backfill = readFileSync(join(__dirname, "..", "..", "scripts", "backfill-ticket-sla.sql"), "utf8");
    const body = backfill
      .split(/\r?\n/)
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");
    // A COMMIT inside the loop, after each batch's UPDATE (a top-level DO allows it on PG >= 11).
    const loop = body.slice(body.indexOf("  LOOP"), body.lastIndexOf("END LOOP"));
    expect(loop).toMatch(/UPDATE "Ticket"[\s\S]*COMMIT;/);
    // No EXCEPTION handler (it would forbid COMMIT) and no explicit transaction wrapper.
    expect(body).not.toMatch(/EXCEPTION WHEN/);
    expect(body).not.toMatch(/^\s*BEGIN;/m);
    // The cutoff: a parameter, defaulting to when the migration was applied; refuses to run without one.
    expect(body).toMatch(/:'cutoff'/);
    expect(body).toMatch(/"_prisma_migrations"[\s\S]*'20261116120000_support_tickets'[\s\S]*finished_at/);
    expect(body).toMatch(/RAISE EXCEPTION/);
    // Both the batch selection and the UPDATE are bounded by the cutoff.
    expect((body.match(/"enteredStageAt" < cutoff/g) ?? []).length).toBe(2);
    // The header documents how to run it (autocommit psql, never --single-transaction).
    expect(backfill).toMatch(/psql/);
    expect(backfill).toMatch(/single-transaction/);
  });

  it("the backfill only touches support pipelines and documents a read-only preflight (final review I1, M4)", () => {
    const backfill = readFileSync(join(__dirname, "..", "..", "scripts", "backfill-ticket-sla.sql"), "utf8");
    const lines = backfill.split(/\r?\n/);
    const body = lines.filter((l) => !/^\s*--/.test(l)).join("\n");
    const header = lines.filter((l) => /^\s*--/.test(l)).join("\n");
    // Both the batch selection and the UPDATE are limited to pipelines of kind 'support'.
    const kindFilter = /"Pipeline" p ON p\."id" = t\."pipelineId" AND p\."kind" = 'support'/g;
    expect((body.match(kindFilter) ?? []).length).toBe(1);
    expect((body.match(/p\."kind" = 'support'/g) ?? []).length).toBe(2);
    const update = body.slice(body.indexOf('UPDATE "Ticket"'));
    expect(update).toMatch(/"Pipeline"/);
    expect(update).toMatch(/p\."kind" = 'support'/);
    // A read-only preflight in the header: what it would update, split by pipeline kind.
    expect(header).toMatch(/Preflight/i);
    expect(header).toMatch(/SELECT p\."kind", count\(\*\)/);
    expect(header).toMatch(/GROUP BY p\."kind"/);
    // M4: honest rerun wording.
    expect(header).toMatch(/no-op only for stages whose slaMinutes did not change/);
    expect(header).not.toMatch(/never changes tickets the trigger left/);
  });
});
