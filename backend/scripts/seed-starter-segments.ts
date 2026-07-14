/* eslint-disable no-console */
// One-off: seed the four starter segments into a given workspace.
// Usage: npx tsx scripts/seed-starter-segments.ts <workspaceId>
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const starters = [
  { name: "All leads", nameAr: "العملاء المحتملون", color: "30",  filter: { lifecycle: ["lead"] } },
  { name: "Customers", nameAr: "العملاء",           color: "150", filter: { lifecycle: ["customer"] } },
  { name: "Has phone", nameAr: "لديهم هاتف",         color: "240", filter: { hasPhone: true } },
  { name: "No phone",  nameAr: "بدون هاتف",          color: "320", filter: { hasPhone: false } },
];

async function main() {
  const wsId = process.argv[2];
  if (!wsId) {
    console.error("usage: tsx scripts/seed-starter-segments.ts <workspaceId>");
    process.exit(1);
  }
  const ws = await prisma.workspace.findUnique({ where: { id: wsId } });
  if (!ws) {
    console.error("workspace not found:", wsId);
    process.exit(2);
  }
  console.log("workspace:", ws.name, `(${ws.id})`);
  for (const s of starters) {
    const existing = await prisma.segment.findFirst({
      where: { workspaceId: wsId, name: s.name },
    });
    if (existing) {
      console.log("  skip (exists):", s.name);
      continue;
    }
    const row = await prisma.segment.create({
      data: {
        workspaceId: wsId,
        name: s.name,
        nameAr: s.nameAr,
        color: s.color,
        filter: JSON.stringify(s.filter),
      },
    });
    console.log("  created:", s.name, `(${row.id})`);
  }
  const total = await prisma.segment.count({ where: { workspaceId: wsId } });
  console.log("total segments now:", total);
}

main()
  .catch((e) => {
    console.error("ERR:", e.message);
    process.exit(3);
  })
  .finally(() => prisma.$disconnect());
