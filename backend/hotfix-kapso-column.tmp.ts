import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function tryOldClientQuery(label: string) {
  // The exact shape the deployed (old) Prisma client needs: selecting the
  // column on Workspace. Raw SQL stands in for the old generated client.
  try {
    await p.$queryRawUnsafe('SELECT "kapsoCustomerId" FROM "Workspace" LIMIT 1');
    console.log(`${label}: old-client query SUCCEEDS`);
    return true;
  } catch (e) {
    console.log(`${label}: old-client query FAILS -> ${(e as Error).message.split("\n")[0]}`);
    return false;
  }
}

async function main() {
  const before = await tryOldClientQuery("BEFORE");
  if (before) {
    console.log("Column already present — nothing to do.");
    return;
  }
  await p.$executeRawUnsafe('ALTER TABLE "Workspace" ADD COLUMN "kapsoCustomerId" TEXT');
  console.log("ALTER applied: kapsoCustomerId re-added as nullable TEXT.");
  const after = await tryOldClientQuery("AFTER");
  if (!after) throw new Error("Column still missing after ALTER — investigate.");
  // Sanity: the workspaces are intact and readable with the column present.
  const rows = await p.$queryRawUnsafe<{ id: string; kapsoCustomerId: string | null }[]>(
    'SELECT id, "kapsoCustomerId" FROM "Workspace"',
  );
  console.log(`Workspaces readable: ${rows.length} row(s), all kapsoCustomerId values:`, [
    ...new Set(rows.map((r) => r.kapsoCustomerId)),
  ]);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERR:", e.message);
    process.exit(1);
  });
