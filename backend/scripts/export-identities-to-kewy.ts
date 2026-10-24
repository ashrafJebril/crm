/* eslint-disable no-console */
// Export every crm user to Kewy's identity store (POST /api/idp/v1/import):
// users with a local password (sent as their bcrypt hash) and SSO-only users
// (no password). Batches of 500. Safe to re-run: Kewy links an identity that
// already exists instead of duplicating it, and never replaces a password.
//
// Usage (from backend/):
//   npx dotenv -e .env -- tsx scripts/export-identities-to-kewy.ts --dry-run
//   npx dotenv -e .env -- tsx scripts/export-identities-to-kewy.ts
//   (or: npm run kewy:export-identities -- --dry-run)
// Needs KEWY_IDP_URL and KEWY_IDP_SECRET. Review IdentityConflict rows in Kewy
// after the dry run, before the real one.
import { PrismaClient } from "@prisma/client";
import {
  KewyIdentityClient,
  type KewyImportResult,
} from "../src/kewy-identity/kewy-identity.client";
import { toKewyIdentity } from "../src/kewy-identity/kewy-identity.sync";

const BATCH = 500;
const dryRun = process.argv.includes("--dry-run");

const prisma = new PrismaClient();
const kewy = new KewyIdentityClient();

async function main() {
  if (!kewy.configured) {
    console.error("KEWY_IDP_URL and KEWY_IDP_SECRET must be set.");
    process.exit(1);
  }
  console.log(`Exporting crm users to Kewy${dryRun ? " (dry run — nothing is written)" : ""}…`);

  const total = { created: 0, linked: 0, updated: 0, conflicts: 0, errors: 0 };
  const conflicts: string[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  let sent = 0;
  let withPassword = 0;
  let cursor: string | undefined;

  for (let batchNo = 1; ; batchNo++) {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, name: true, password: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (users.length === 0) break;
    cursor = users[users.length - 1].id;

    const identities = users.flatMap((u) => {
      const row = toKewyIdentity(u);
      // Kewy cannot create an account without an email or phone; SSO
      // placeholder addresses (…@sso.local) are not sent.
      if (!row.email) {
        skipped.push(`${u.id} <${u.email}>`);
        return [];
      }
      if (row.passwordHash) withPassword++;
      return [row];
    });
    if (identities.length === 0) continue;

    const res = await kewy.importIdentities({ dryRun, identities });
    if (res.kind !== "ok") {
      console.error(
        `Batch ${batchNo} failed: ${
          res.kind === "rejected" ? `${res.status} ${res.code} ${res.message ?? ""}` : res.reason
        }`,
      );
      console.error(`Stopped after ${sent} users. Re-running is safe.`);
      process.exitCode = 1;
      break;
    }
    const data: KewyImportResult = res.data;
    sent += identities.length;
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += data.summary[k] ?? 0;
    for (const r of data.results) {
      if ("error" in r) errors.push(`${r.externalUserId}: ${r.error}`);
      else if (r.conflict) conflicts.push(`${r.externalUserId} → account ${r.accountId ?? "(new)"}`);
    }
    console.log(
      `Batch ${batchNo}: ${identities.length} sent — created ${data.summary.created}, linked ${data.summary.linked}, updated ${data.summary.updated}, conflicts ${data.summary.conflicts}, errors ${data.summary.errors}`,
    );
  }

  console.log("\n── Summary ──");
  console.log(`Sent: ${sent} (${withPassword} with a password hash, ${sent - withPassword} SSO-only)`);
  console.log(
    `Created ${total.created}, linked ${total.linked}, updated ${total.updated}, conflicts ${total.conflicts}, errors ${total.errors}`,
  );
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length} without a usable email:`);
    for (const s of skipped) console.log(`  ${s}`);
  }
  if (conflicts.length) {
    console.log(`\nConflicts (linked by email; review IdentityConflict in Kewy):`);
    for (const c of conflicts) console.log(`  ${c}`);
  }
  if (errors.length) {
    console.log(`\nErrors (row skipped by Kewy):`);
    for (const e of errors) console.log(`  ${e}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
