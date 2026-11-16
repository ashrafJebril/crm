import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261116130000_bookings_catalog";
/** sha256 of applied files (LF, as committed). Applied in production: never edit them. */
const PINNED: Record<string, string> = {
  "20261115130000_smart_audiences": "610081cbf5b7275c45447b830bafb7303aa286edb062de5aeaae26962d0cc083",
  "20261115140000_media_ai_details": "f2f306360781f306d7cf7d7181693576ef12706847c2298bf3fcfedad2cb4334",
  "20261116120000_support_tickets": "555000f79d7d764bf69429a0bd56b52b4893802e56a5e4cc01da949ef7b6e22c",
};

/**
 * What `prisma migrate diff --from-schema-datamodel <9b2a29d schema>
 * --to-schema-datamodel prisma/schema.prisma --script` printed for this change
 * (Prisma 5.22.0, run 2026-11-16, no DB), whitespace-collapsed. The file must
 * equal it apart from `IF NOT EXISTS` and the duplicate_object wrappers.
 */
const PRISMA_DIFF = [
  'ALTER TABLE "Appointment" ADD COLUMN "resourceId" TEXT, ADD COLUMN "serviceId" TEXT, ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;',
  'CREATE TABLE "Service" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "name" TEXT NOT NULL, "nameAr" TEXT NOT NULL, ' +
    '"color" TEXT NOT NULL DEFAULT \'info\', "durationMin" INTEGER NOT NULL, "price" DECIMAL(12,2), "currency" TEXT NOT NULL DEFAULT \'SAR\', ' +
    '"active" BOOLEAN NOT NULL DEFAULT true, "archivedAt" TIMESTAMP(3), "order" INTEGER NOT NULL DEFAULT 0, "version" INTEGER NOT NULL DEFAULT 0, ' +
    '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Service_pkey" PRIMARY KEY ("id") );',
  'CREATE TABLE "StaffResource" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "userId" TEXT, "name" TEXT NOT NULL, "nameAr" TEXT, ' +
    '"role" TEXT, "color" TEXT NOT NULL DEFAULT \'accent\', "schedule" JSONB NOT NULL DEFAULT \'{}\', "active" BOOLEAN NOT NULL DEFAULT true, ' +
    '"archivedAt" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
    '"updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "StaffResource_pkey" PRIMARY KEY ("id") );',
  'CREATE TABLE "StaffService" ( "resourceId" TEXT NOT NULL, "serviceId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, ' +
    '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "StaffService_pkey" PRIMARY KEY ("resourceId","serviceId") );',
  'CREATE TABLE "CatalogImport" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "createdById" TEXT, "source" TEXT NOT NULL, ' +
    '"kind" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT \'extracting\', "inputText" TEXT, "sourceUrl" TEXT, "fileMediaId" TEXT, ' +
    '"fileName" TEXT, "extractedBy" TEXT, "proposal" JSONB, "total" INTEGER NOT NULL DEFAULT 0, "processed" INTEGER NOT NULL DEFAULT 0, ' +
    '"created" INTEGER NOT NULL DEFAULT 0, "skipped" INTEGER NOT NULL DEFAULT 0, "failed" INTEGER NOT NULL DEFAULT 0, ' +
    '"errors" JSONB NOT NULL DEFAULT \'[]\', "errorKey" TEXT, "heartbeatAt" TIMESTAMP(3), "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3), ' +
    '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "CatalogImport_pkey" PRIMARY KEY ("id") );',
  'CREATE INDEX "Service_workspaceId_active_idx" ON "Service"("workspaceId", "active");',
  'CREATE INDEX "StaffResource_workspaceId_active_idx" ON "StaffResource"("workspaceId", "active");',
  'CREATE UNIQUE INDEX "StaffResource_workspaceId_userId_key" ON "StaffResource"("workspaceId", "userId");',
  'CREATE INDEX "StaffService_serviceId_idx" ON "StaffService"("serviceId");',
  'CREATE INDEX "CatalogImport_workspaceId_createdAt_idx" ON "CatalogImport"("workspaceId", "createdAt");',
  'CREATE INDEX "CatalogImport_status_heartbeatAt_idx" ON "CatalogImport"("status", "heartbeatAt");',
  'CREATE INDEX "Appointment_workspaceId_startAt_idx" ON "Appointment"("workspaceId", "startAt");',
  'CREATE INDEX "Appointment_workspaceId_resourceId_startAt_idx" ON "Appointment"("workspaceId", "resourceId", "startAt");',
  'CREATE INDEX "Appointment_workspaceId_serviceId_idx" ON "Appointment"("workspaceId", "serviceId");',
  'ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
  'ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "StaffResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
  'ALTER TABLE "Service" ADD CONSTRAINT "Service_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "StaffResource" ADD CONSTRAINT "StaffResource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "StaffResource" ADD CONSTRAINT "StaffResource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
  'ALTER TABLE "StaffService" ADD CONSTRAINT "StaffService_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "StaffResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "StaffService" ADD CONSTRAINT "StaffService_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "CatalogImport" ADD CONSTRAINT "CatalogImport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  'ALTER TABLE "CatalogImport" ADD CONSTRAINT "CatalogImport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
  'ALTER TABLE "CatalogImport" ADD CONSTRAINT "CatalogImport_fileMediaId_fkey" FOREIGN KEY ("fileMediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
];

/** Hash as committed (LF), whatever the checkout's autocrlf did. */
const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-10 bookings catalog migration", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const sql = raw.toString("utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-10)", () => {
    // Every CREATE TABLE, CREATE INDEX and ADD COLUMN is IF NOT EXISTS.
    const creates = code.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^(;]*/gi) ?? [];
    expect(creates).toHaveLength(13); // four tables, nine indexes
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /i);
    const addCols = code.match(/ADD COLUMN[^,;]*/gi) ?? [];
    expect(addCols).toHaveLength(3);
    for (const a of addCols) expect(a).toMatch(/^ADD COLUMN IF NOT EXISTS/i);

    // Exact names (Global Constraints → Migration).
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "serviceId" TEXT,/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "resourceId" TEXT,/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;/);
    for (const table of ["Service", "StaffResource", "StaffService", "CatalogImport"]) {
      expect(code).toContain(`CREATE TABLE IF NOT EXISTS "${table}" (`);
    }
    expect(code).toContain('CONSTRAINT "StaffService_pkey" PRIMARY KEY ("resourceId","serviceId")');
    expect(code).toContain('"schedule" JSONB NOT NULL DEFAULT \'{}\'');
    expect(code).toContain('"errors" JSONB NOT NULL DEFAULT \'[]\'');
    expect(code).toContain('"price" DECIMAL(12,2)');
    for (const name of [
      '"Service_workspaceId_active_idx"',
      '"StaffResource_workspaceId_active_idx"',
      '"StaffResource_workspaceId_userId_key"',
      '"StaffService_serviceId_idx"',
      '"CatalogImport_workspaceId_createdAt_idx"',
      '"CatalogImport_status_heartbeatAt_idx"',
      '"Appointment_workspaceId_startAt_idx"',
      '"Appointment_workspaceId_resourceId_startAt_idx"',
      '"Appointment_workspaceId_serviceId_idx"',
    ]) {
      expect(code).toContain(name);
    }

    // Every FK sits in its own duplicate_object block, with the plan's actions.
    const fks: [string, string, string, string, string][] = [
      ["Service", "Service_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["StaffResource", "StaffResource_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["StaffResource", "StaffResource_userId_fkey", "userId", "User", "SET NULL"],
      ["StaffService", "StaffService_resourceId_fkey", "resourceId", "StaffResource", "CASCADE"],
      ["StaffService", "StaffService_serviceId_fkey", "serviceId", "Service", "CASCADE"],
      ["CatalogImport", "CatalogImport_workspaceId_fkey", "workspaceId", "Workspace", "CASCADE"],
      ["CatalogImport", "CatalogImport_createdById_fkey", "createdById", "User", "SET NULL"],
      ["CatalogImport", "CatalogImport_fileMediaId_fkey", "fileMediaId", "Media", "SET NULL"],
      ["Appointment", "Appointment_serviceId_fkey", "serviceId", "Service", "SET NULL"],
      ["Appointment", "Appointment_resourceId_fkey", "resourceId", "StaffResource", "SET NULL"],
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

    // Nothing destructive, no backfill, the legacy "service" column untouched.
    const statementsOnly = code.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL)/g, "");
    for (const bad of [/\bDROP\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /ALTER COLUMN/i, /\bTYPE\b/i, /\bTRIGGER\b/i]) {
      expect({ bad: String(bad), hit: bad.test(statementsOnly) }).toEqual({ bad: String(bad), hit: false });
    }
    expect(code).not.toMatch(/"service"\s/);
    expect(code).not.toMatch(/"serviceAr"/);

    // Ordered after every applied migration (SP-09's is the latest applied).
    expect(FOLDER.slice(0, 14) > "20261116120000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders[folders.indexOf(FOLDER) - 1]).toBe("20261116120000_support_tickets");

    // LF only (Prisma checksums the exact bytes; .gitattributes enforces it on commit).
    expect(raw.includes(Buffer.from("\r\n"))).toBe(false);
  });

  it("equals prisma migrate diff apart from IF NOT EXISTS, the DO wrappers, lock_timeout and Appointment-last order", () => {
    const statements = code
      .replace(/^SET lock_timeout = '5s';$/m, "")
      .replace(/IF NOT EXISTS /g, "")
      .replace(/DO \$\$ BEGIN([\s\S]*?)EXCEPTION WHEN duplicate_object THEN NULL;\s*END \$\$;/g, "$1")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((s) => `${s};`);
    // Review M1: every "Appointment" statement runs last (it holds ACCESS
    // EXCLUSIVE until commit), otherwise in Prisma's order.
    const onAppointment = (st: string) => st.startsWith('ALTER TABLE "Appointment"') || st.includes(' ON "Appointment"(');
    expect(statements).toEqual([...PRISMA_DIFF.filter((st) => !onAppointment(st)), ...PRISMA_DIFF.filter(onAppointment)]);
    expect(PRISMA_DIFF.filter(onAppointment)).toHaveLength(6);
  });

  it("sets lock_timeout first and documents that Appointment reads and writes block (review M1)", () => {
    const firstStatement = code.split(";")[0].trim();
    expect(firstStatement).toBe("SET lock_timeout = '5s'");
    expect((code.match(/^SET /gm) ?? []).length).toBe(1);
    expect(sql).toMatch(/ACCESS EXCLUSIVE/);
    expect(sql).toMatch(/READS AND WRITES on "Appointment"/);
    expect(sql).not.toMatch(/block booking writes for/);
  });

  it.each(Object.entries(PINNED))("the applied %s file is unchanged (sha256)", (folder, sha) => {
    expect(lfSha(readFileSync(join(MIGRATIONS, folder, "migration.sql")))).toBe(sha);
  });

  it("schema.prisma declares the SP-10 models and Appointment columns", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
    const block = (name: string) => schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
    const appt = block("Appointment");
    // The legacy free-text columns stay.
    expect(appt).toMatch(/\n\s+service\s+String\n/);
    expect(appt).toMatch(/\n\s+serviceAr\s+String\n/);
    expect(appt).toMatch(/\n\s+staffId\s+String\?/);
    expect(appt).toMatch(/serviceRef\s+Service\?\s+@relation\("AppointmentService", fields: \[serviceId\], references: \[id\], onDelete: SetNull\)/);
    expect(appt).toMatch(/resource\s+StaffResource\?\s+@relation\("AppointmentResource", fields: \[resourceId\], references: \[id\], onDelete: SetNull\)/);
    expect(appt).toMatch(/version\s+Int\s+@default\(0\)/);
    const svc = block("Service");
    expect(svc).toMatch(/price\s+Decimal\?\s+@db\.Decimal\(12, 2\)/);
    expect(svc).toMatch(/color\s+String\s+@default\("info"\)/);
    const res = block("StaffResource");
    expect(res).toMatch(/schedule\s+Json\s+@default\("\{\}"\)/);
    expect(res).toMatch(/@@unique\(\[workspaceId, userId\]\)/);
    expect(block("StaffService")).toMatch(/@@id\(\[resourceId, serviceId\]\)/);
    expect(block("CatalogImport")).toMatch(/status\s+String\s+@default\("extracting"\)/);
  });
});
