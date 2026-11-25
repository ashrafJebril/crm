import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "prisma", "migrations");
const FOLDER = "20261118140000_billing_portal";
/** sha256 of earlier files (LF, as committed). Never edit them. Ordering is
 *  relative, not adjacency: other SPs' migrations may land in between. */
const PINNED: Record<string, string> = {
  "20261116120000_support_tickets": "555000f79d7d764bf69429a0bd56b52b4893802e56a5e4cc01da949ef7b6e22c",
  "20261116130000_bookings_catalog": "913dad261ab4f163019f2d3c3c1b8a8bdf98ca08e233bcad489aa373aef08875",
  "20261116140000_insights_home": "a203771a9711c07a15bd26ab41635af9e2177ac0cdb767b434242d9d36ba9013",
  "20261117120000_knowledge_upgrade": "463dcac144c1c369fd40479007ec824a21e766c34238d19ab2705a3db6c4a1db",
  "20261117130000_agent_config": "0389880cc4dde498652acd083596b9e5e89f303e575e275e646784fde617f5ce",
  "20261117140000_copilot": "389bd9bd9db4b739af9be3a2975a8272767dc09357611082474c02ff2a412f13",
  "20261117150000_lifecycle_messages": "f77f8fd558338996675b18b4d757ebb8117ceb512b364fd3b3d009315a77ce34",
  "20261117160000_skills_gallery": "28374cfb0b9d1f7c9658e59253484ec2510ac963833c62ba78d2087b8d39d4f2",
  "20261118120000_members_security": "f0a7a531550ffdf36bdfb94d24fc22affdd20d3094ec303c01e44cd469635767",
  "20261118130000_api_keys_webhooks": "eeec6199af34d73757aaf08a0aabe304b014a0429eeca57955c2d8ecc2f777d5",
};

/**
 * What `prisma migrate diff` (Prisma 5.22) yields for the re-scoped SP-28
 * models, whitespace-collapsed. Hand-derived in Prisma's output format; no
 * `prisma migrate` command was run. The file must equal it apart from
 * `IF NOT EXISTS`, the duplicate_object wrapper, the lock_timeout line and
 * statement order.
 */
const PRISMA_DIFF = [
  'ALTER TABLE "Workspace" ADD COLUMN "planOverriddenAt" TIMESTAMP(3), ADD COLUMN "kewyPlan" TEXT;',
  'ALTER TABLE "AdsWalletTransaction" ADD COLUMN "meter" TEXT;',
  'CREATE TABLE "UsageEvent" ( "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "meter" TEXT NOT NULL, ' +
    '"qty" INTEGER NOT NULL DEFAULT 1, "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "sourceKind" TEXT NOT NULL, ' +
    '"sourceId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "walletTxId" TEXT, ' +
    'CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id") );',
  'CREATE UNIQUE INDEX "UsageEvent_idempotencyKey_key" ON "UsageEvent"("idempotencyKey");',
  'CREATE INDEX "UsageEvent_workspaceId_meter_at_idx" ON "UsageEvent"("workspaceId", "meter", "at");',
  'ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
];

const lfSha = (bytes: Buffer) =>
  createHash("sha256").update(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")).digest("hex");

describe("SP-28 billing portal migration (re-scoped: no Stripe)", () => {
  const raw = readFileSync(join(MIGRATIONS, FOLDER, "migration.sql"));
  const sql = raw.toString("utf8");
  const code = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  it("migration is additive, idempotent and Prisma-named (SP-28)", () => {
    const creates = code.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^(;]*/gi) ?? [];
    expect(creates).toHaveLength(3); // one table, two indexes
    for (const c of creates) expect(c).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /i);
    const adds = code.match(/ADD COLUMN [^,;]*/gi) ?? [];
    expect(adds).toHaveLength(3);
    for (const a of adds) {
      expect(a).toMatch(/^ADD COLUMN IF NOT EXISTS /);
      // Nullable, no default: metadata-only on Postgres 11+.
      expect(a).not.toMatch(/NOT NULL|DEFAULT/);
    }

    const blocks = code.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(
      'ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    );
    expect(blocks[0]).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;/);

    const statementsOnly = code.replace(/ON (DELETE|UPDATE) CASCADE/g, "");
    for (const bad of [/\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i, /ALTER COLUMN/i, /\bTYPE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i]) {
      expect({ bad: String(bad), hit: bad.test(statementsOnly) }).toEqual({ bad: String(bad), hit: false });
    }
    // No Stripe objects (controller re-scope).
    expect(code).not.toMatch(/Stripe|Subscription|stripeCustomerId|billingSource|trialEndsAt/);

    // After SP-27 and every pinned predecessor (relative order, not adjacency).
    expect(FOLDER.slice(0, 14) > "20261118130000").toBe(true);
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders).toContain(FOLDER);
    for (const before of Object.keys(PINNED)) {
      expect({ before, after: folders.indexOf(FOLDER) > folders.indexOf(before) }).toEqual({ before, after: true });
    }
    // The folder name is unique.
    expect(folders.filter((f) => f.startsWith("20261118140000"))).toEqual([FOLDER]);

    expect(raw.includes(Buffer.from("\r\n"))).toBe(false);
  });

  it("equals prisma migrate diff apart from IF NOT EXISTS, the DO wrapper, lock_timeout and order", () => {
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

  it("schema.prisma declares the SP-28 models as the plan names them", () => {
    const schema = readFileSync(join(MIGRATIONS, "..", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
    const block = (name: string) => schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
    const usage = block("UsageEvent");
    expect(usage).toMatch(/meter\s+String/);
    expect(usage).toMatch(/qty\s+Int\s+@default\(1\)/);
    expect(usage).toMatch(/idempotencyKey\s+String\s+@unique/);
    expect(usage).toMatch(/@@index\(\[workspaceId, meter, at\]\)/);
    expect(usage).toMatch(/onDelete: Cascade/);
    expect(block("AdsWalletTransaction")).toMatch(/meter\s+String\?/);
    const ws = block("Workspace");
    expect(ws).toMatch(/planOverriddenAt\s+DateTime\?/);
    expect(ws).toMatch(/kewyPlan\s+String\?/);
    // Re-scope: no Stripe models or columns.
    expect(schema).not.toMatch(/model (Subscription|StripeEvent) /);
    expect(ws).not.toMatch(/billingSource|stripeCustomerId|trialEndsAt/);
  });
});
