/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // 1) Get or create the Default Workspace (idempotent).
  let defaultWs = await prisma.workspace.findFirst({
    where: { slug: "default" },
  });
  if (!defaultWs) {
    defaultWs = await prisma.workspace.create({
      data: {
        name: "Default Workspace",
        slug: "default",
        timezone: "Asia/Riyadh",
        lang: "ar",
        plan: "free",
      },
    });
    console.log(`Created Default Workspace: ${defaultWs.id}`);
  } else {
    console.log(`Default Workspace already exists: ${defaultWs.id}`);
  }
  const wsId = defaultWs.id;

  // 2) Make every existing user an Owner of the Default Workspace (idempotent).
  const users = await prisma.user.findMany();
  for (const u of users) {
    const existing = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: u.id, workspaceId: wsId } },
    });
    if (!existing) {
      await prisma.workspaceMember.create({
        data: { userId: u.id, workspaceId: wsId, role: "owner" },
      });
      console.log(`  Added ${u.email} as owner`);
    }
  }

  // 3) Backfill workspaceId on every customer-owned table.
  //
  // Raw SQL on purpose: the Prisma schema already declares workspaceId as a
  // required String, so the generated client can't express `where: { workspaceId: null }`
  // even though pre-migration rows still hold NULLs. We also skip tables that
  // don't exist (or don't have the column) in this database, so the script stays
  // safe to run against schemas at different migration points.
  const TABLES = [
    "Contact",
    "Conversation",
    "Message",
    "Appointment",
    "Template",
    "Tag",
    "Segment",
    "Campaign",
    "Pipeline",
    "TicketStage",
    "Ticket",
    "TicketActivity",
    "Integration",
    "Workflow",
    "WorkflowRun",
    "Media",
    "Keyword",
    "Mention",
    "Note",
  ] as const;

  const present = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND column_name = 'workspaceId'
  `;
  const presentTables = new Set(present.map((r) => r.table_name));

  const targets = TABLES.filter((t) => presentTables.has(t));
  const skipped = TABLES.filter((t) => !presentTables.has(t));
  if (skipped.length > 0) {
    console.log(`\nSkipping tables not present in this database: ${skipped.join(", ")}`);
  }

  const updates: Array<{ name: string; count: number }> = [];
  for (const table of targets) {
    const count = await prisma.$executeRawUnsafe(
      `UPDATE "${table}" SET "workspaceId" = $1 WHERE "workspaceId" IS NULL`,
      wsId,
    );
    updates.push({ name: table, count });
  }

  console.log("\nBackfill summary:");
  for (const u of updates) console.log(`  ${u.name.padEnd(20)} ${u.count}`);

  // 4) Verify no rows remain with null workspaceId.
  const checks: Array<{ name: string; nulls: number }> = [];
  for (const table of targets) {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "${table}" WHERE "workspaceId" IS NULL`,
    );
    checks.push({ name: table, nulls: Number(rows[0]?.count ?? 0) });
  }
  const stillNull = checks.filter((c) => c.nulls > 0);
  if (stillNull.length > 0) {
    console.error("\nFAILED: some tables still have null workspaceId rows:");
    for (const c of stillNull) console.error(`  ${c.name}: ${c.nulls}`);
    process.exit(1);
  }
  console.log("\nAll customer-owned rows are now scoped to a workspace. ✓");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
