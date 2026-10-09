/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { seedWorkspaceDefaults } from "../src/workspaces/workspace-defaults";

const prisma = new PrismaClient();

// ─── Helpers ──────────────────────────────────────────────────────────────
function thisMonday(): Date {
  const now = new Date();
  const day = now.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  const m = new Date(now);
  m.setDate(now.getDate() + offset);
  m.setHours(0, 0, 0, 0);
  return m;
}
const M = thisMonday();
const dayAt = (offset: number, h: number, mn = 0): Date => {
  const d = new Date(M);
  d.setDate(M.getDate() + offset);
  d.setHours(h, mn, 0, 0);
  return d;
};

// ─── Reset (idempotent) ───────────────────────────────────────────────────
async function reset() {
  await prisma.ticketActivity.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.ticketStage.deleteMany();
  await prisma.pipeline.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.template.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.note.deleteMany();
  await prisma.integration.deleteMany();
  await prisma.workspaceMember.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
}

// ─── Seed body ────────────────────────────────────────────────────────────
async function main() {
  await reset();

  // Default Workspace
  const defaultWs = await prisma.workspace.create({
    data: {
      name: "Default Workspace",
      slug: "default",
      timezone: "Asia/Riyadh",
      lang: "ar",
      plan: "free",
    },
  });
  const wsId = defaultWs.id;

  // Users (a.k.a. team)
  const password = await bcrypt.hash("demo1234", 10);
  const yara = await prisma.user.create({
    data: { email: "yara@samemha.com",  password, name: "Yara Khaled",   role: "Owner",   initials: "YK", color: "150", status: "online", isSuperAdmin: true },
  });
  await prisma.workspaceMember.create({ data: { userId: yara.id, workspaceId: wsId, role: "owner" } });

  const omar = await prisma.user.create({
    data: { email: "omar@samemha.com",  password, name: "Omar Daher",    role: "Manager", initials: "OD", color: "240", status: "online", twoFA: true },
  });
  await prisma.workspaceMember.create({ data: { userId: omar.id, workspaceId: wsId, role: "admin" } });

  const lina = await prisma.user.create({
    data: { email: "lina@samemha.com",  password, name: "Lina Saad",     role: "Agent",   initials: "LS", color: "320", status: "away",   twoFA: true },
  });
  await prisma.workspaceMember.create({ data: { userId: lina.id, workspaceId: wsId, role: "agent" } });

  const karim = await prisma.user.create({
    data: { email: "karim@samemha.com", password, name: "Karim Idrissi", role: "Agent",   initials: "KI", color: "60",  status: "offline" },
  });
  await prisma.workspaceMember.create({ data: { userId: karim.id, workspaceId: wsId, role: "agent" } });

  // No mock contacts — they get materialized from real Inbox conversations
  // when the user clicks "Convert to ticket".  Keeps the workspace clean.

  // No mock conversations or appointments either.  Real conversations come
  // through the Facebook/Instagram/etc. integrations; appointments are user-created.

  // Templates — demo rows, deliberately status "local".
  //
  // These used to be seeded as "approved", which made them indistinguishable
  // from real Meta-approved templates in a workspace that HAS a live WhatsApp
  // connection. The Templates screen advertised them as sendable and every
  // send failed, because Meta had never seen them. "local" is the honest
  // status: stored here, not approved by Meta, not sendable.
  const tpls = [
    { name: "order_confirmed_v2", lang: "en", category: "TRANSACTIONAL", status: "local",    uses: 4812 },
    { name: "appointment_24h",    lang: "en", category: "UTILITY",       status: "local",    uses: 1304 },
    { name: "abandoned_cart_24h", lang: "en", category: "MARKETING",     status: "local",    uses: 412 },
    { name: "tahdid_eid_promo",   lang: "ar", category: "MARKETING",     status: "local",    uses: 0 },
  ];
  for (const t of tpls) await prisma.template.create({ data: { ...t, workspaceId: wsId } });

  // Campaigns
  const cmps = [
    { name: "Eid Pre-orders 2026",     status: "running",   audience: "VIP · Riyadh",          recipients: 1842, sent: 1820, delivered: 1808, read: 1342, replied: 487, conversions: 91,  channel: "Broadcast",      schedule: "Apr 28, 9:00"  },
    { name: "Spring drop · waitlist",  status: "scheduled", audience: "Trial · Hot",           recipients: 624,  sent: 0,    delivered: 0,    read: 0,    replied: 0,   conversions: 0,   channel: "Drip · 4 steps", schedule: "May 12, 10:00" },
    { name: "Clinic reminders",        status: "running",   audience: "Patients · 24h before", recipients: 156,  sent: 156,  delivered: 154,  read: 142,  replied: 38,  conversions: 134, channel: "Trigger",        schedule: null            },
    { name: "Abandoned cart recovery", status: "running",   audience: "Cart > 24h",            recipients: 412,  sent: 412,  delivered: 408,  read: 312,  replied: 81,  conversions: 47,  channel: "Trigger",        schedule: null            },
    { name: "Ramadan menu launch",     status: "draft",     audience: "All customers",         recipients: 0,    sent: 0,    delivered: 0,    read: 0,    replied: 0,   conversions: 0,   channel: "Broadcast",      schedule: null            },
    { name: "Q1 NPS survey",           status: "completed", audience: "Repeat · 60d",          recipients: 2104, sent: 2104, delivered: 2087, read: 1612, replied: 904, conversions: 0,   channel: "Broadcast",      schedule: "Mar 03, 11:00" },
  ];
  for (const c of cmps) await prisma.campaign.create({ data: { ...c, workspaceId: wsId } });

  // ─── Pipeline + stages + smart groups ────────────────────────────────────
  // Same defaults every workspace gets at provisioning time, from the one
  // definition in src/workspaces/workspace-defaults.ts.
  await seedWorkspaceDefaults(prisma, wsId);

  console.log(`✓ Seeded with default user yara@samemha.com / demo1234`);
  console.log(`  Workspace: ${defaultWs.name} (id: ${wsId}, slug: ${defaultWs.slug})`);
  console.log(`  Owner user id: ${yara.id}`);
  console.log(`  WorkspaceMembers: owner(yara), admin(omar), agent(lina), agent(karim)`);
  console.log(`  Pipeline: Sales (6 stages: new, contacted, interested, waiting, won, lost)`);
  console.log(`  Tickets: 0 — start clean, create your own from the Inbox`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
