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
  const updates: Array<{ name: string; count: number }> = [];

  for (const [name, fn] of [
    ["Contact",         () => prisma.contact.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Conversation",    () => prisma.conversation.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Message",         () => prisma.message.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Appointment",     () => prisma.appointment.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Template",        () => prisma.template.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Campaign",        () => prisma.campaign.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Pipeline",        () => prisma.pipeline.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["TicketStage",     () => prisma.ticketStage.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Ticket",          () => prisma.ticket.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["TicketActivity",  () => prisma.ticketActivity.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Integration",     () => prisma.integration.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Keyword",         () => prisma.keyword.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Mention",         () => prisma.mention.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Note",            () => prisma.note.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
  ] as const) {
    const res = await fn();
    updates.push({ name, count: res.count });
  }

  console.log("\nBackfill summary:");
  for (const u of updates) console.log(`  ${u.name.padEnd(20)} ${u.count}`);

  // 4) Verify no rows remain with null workspaceId.
  const checks: Array<{ name: string; nulls: number }> = [];
  for (const [name, fn] of [
    ["Contact",         () => prisma.contact.count({ where: { workspaceId: null } })],
    ["Conversation",    () => prisma.conversation.count({ where: { workspaceId: null } })],
    ["Message",         () => prisma.message.count({ where: { workspaceId: null } })],
    ["Appointment",     () => prisma.appointment.count({ where: { workspaceId: null } })],
    ["Template",        () => prisma.template.count({ where: { workspaceId: null } })],
    ["Campaign",        () => prisma.campaign.count({ where: { workspaceId: null } })],
    ["Pipeline",        () => prisma.pipeline.count({ where: { workspaceId: null } })],
    ["TicketStage",     () => prisma.ticketStage.count({ where: { workspaceId: null } })],
    ["Ticket",          () => prisma.ticket.count({ where: { workspaceId: null } })],
    ["TicketActivity",  () => prisma.ticketActivity.count({ where: { workspaceId: null } })],
    ["Integration",     () => prisma.integration.count({ where: { workspaceId: null } })],
    ["Keyword",         () => prisma.keyword.count({ where: { workspaceId: null } })],
    ["Mention",         () => prisma.mention.count({ where: { workspaceId: null } })],
    ["Note",            () => prisma.note.count({ where: { workspaceId: null } })],
  ] as const) {
    checks.push({ name, nulls: await fn() });
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
