/**
 * The working home's REAL SQL against Postgres. Skipped unless
 * INSIGHTS_TEST_DATABASE_URL points at a migrated database (the rest of the
 * suite stays DB-free). Seeds two throwaway workspaces and deletes them.
 */
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import { HomeService } from "./home.service";
import type { HomeDto } from "./home.dto";

const url = process.env.INSIGHTS_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const NOW = new Date("2026-11-10T09:00:00Z"); // 12:00 Riyadh
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const ok = <T>(s: { status: string; data?: T }): T => {
  if (s.status !== "ok") throw new Error(`section ${s.status}`);
  return s.data as T;
};

d("working home SQL against Postgres", () => {
  let prisma: PrismaService;
  let svc: HomeService;
  const tag = `zz-home-${Date.now().toString(36)}`;
  const ids: Record<string, string> = {};
  const users: string[] = [];
  let ws = "";
  let foreignWs = "";

  async function user(key: string, name: string) {
    const u = await prisma.raw.user.create({ data: { email: `${tag}+${key}@insights.invalid`, name, initials: name.slice(0, 2), color: "150" } });
    users.push(u.id);
    ids[key] = u.id;
    return u.id;
  }

  async function conv(
    key: string,
    workspaceId: string,
    assigneeId: string | null,
    msgs: [from: string, at: Date, sentById?: string][],
    over: Record<string, unknown> = {},
  ) {
    const ct = await prisma.raw.contact.create({ data: { workspaceId, name: `Contact ${key}`, industry: "—", lifecycle: "customer", source: "whatsapp", lastSeen: "now" } });
    const c = await prisma.raw.conversation.create({
      data: { workspaceId, contactId: ct.id, assigneeId, channel: "whatsapp", lastAt: "now", lastFrom: "them", preview: "", status: "human", intent: "", confidence: 0, ...over },
    });
    ids[key] = c.id;
    ids[`contact-${key}`] = ct.id;
    for (const [from, createdAt, sentById] of msgs) {
      await prisma.raw.message.create({ data: { workspaceId, conversationId: c.id, from, body: from, t: "00:00", createdAt, sentById: sentById ?? null } });
    }
    return c.id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    svc = new HomeService(prisma, new PermissionService(prisma));

    ws = (await prisma.raw.workspace.create({ data: { name: `Home ${tag}`, slug: tag, timezone: "Asia/Riyadh", lang: "ar" } })).id;
    foreignWs = (await prisma.raw.workspace.create({ data: { name: `Home B ${tag}`, slug: `${tag}-b`, timezone: "Asia/Riyadh" } })).id;
    const owner = await user("owner", "Omar");
    const sami = await user("sami", "Sami");
    const badr = await user("badr", "Badr");
    const amal = await user("amal", "Amal");
    const role = await prisma.raw.role.create({
      data: {
        workspaceId: ws,
        key: null,
        name: `Assigned ${tag}`,
        nameAr: "Assigned",
        permissions: { conversations: ["view", "create", "update"], contacts: ["view"] },
        conversationVisibility: "assigned",
      },
    });
    await prisma.raw.workspaceMember.create({ data: { workspaceId: ws, userId: owner, role: "owner" } });
    await prisma.raw.workspaceMember.create({ data: { workspaceId: ws, userId: sami, role: "custom", roleId: role.id, homeSeenAt: ago(6 * 60) } });
    await prisma.raw.workspaceMember.create({ data: { workspaceId: ws, userId: badr, role: "agent" } });
    await prisma.raw.workspaceMember.create({ data: { workspaceId: ws, userId: amal, role: "admin" } });

    // Waiting candidates for Sami (assigned-only).
    await conv("sami-wait", ws, sami, [["them", ago(180)]]);
    await conv("sami-ai", ws, sami, [["them", ago(120)], ["ai", ago(300)]], { aiEnabled: true });
    await conv("sami-esc", ws, sami, [["them", ago(60)]], { aiEnabled: true, escalated: true });
    // AI on but paused by a staff takeover, and the customer wrote last: needs a person (ruling).
    await conv("sami-paused", ws, sami, [["them", ago(170)], ["human", ago(160), sami], ["them", ago(150)]], {
      aiEnabled: true,
      aiPausedAt: ago(160),
    });
    await conv("sami-pending", ws, sami, [["them", ago(50)]], { status: "pending_customer" });
    await conv("sami-closed", ws, sami, [["them", ago(40)]], { status: "closed" });
    await conv("sami-staff", ws, sami, [["them", ago(90)], ["human", ago(30), sami]]);
    await conv("unassigned", ws, null, [["them", ago(240)]]);
    await conv("badr", ws, badr, [["them", ago(200)], ["ai", ago(299)]], { aiEnabled: false });
    // AI-resolved since Sami last looked: his and Badr's.
    await conv("sami-res", ws, sami, [["them", ago(200)], ["ai", ago(199)]], { resolutionStatus: "resolved", resolvedAt: ago(120) });
    await conv("badr-res", ws, badr, [["them", ago(200)], ["ai", ago(198)]], { resolutionStatus: "resolved", resolvedAt: ago(110) });
    // Another workspace's waiting thread.
    await conv("foreign", foreignWs, null, [["them", ago(500)]]);

    // Follow-ups for Sami (Riyadh: today = [09 Nov 21:00Z, 10 Nov 21:00Z)).
    const fu = (title: string, dueAt: Date, extra: Record<string, unknown> = {}) =>
      prisma.raw.activity.create({ data: { workspaceId: ws, kind: "call", title, assigneeId: sami, dueAt, contactId: ids["contact-sami-wait"], ...extra } });
    await fu("late", new Date("2026-11-09T10:00:00Z"));
    await fu("today 23:30", new Date("2026-11-10T20:30:00Z"));
    await fu("tomorrow 00:10", new Date("2026-11-10T21:10:00Z"));

    // A support pipeline with an unowned open ticket; a ticket-linked late follow-up for Sami.
    const pl = await prisma.raw.pipeline.create({ data: { workspaceId: ws, key: "support", name: "Support", nameAr: "الدعم", kind: "support" } });
    const st = await prisma.raw.ticketStage.create({
      data: { workspaceId: ws, pipelineId: pl.id, key: "open", label: "Open", labelAr: "مفتوحة", color: "bad", order: 0, groupKey: "support_open" },
    });
    const tk = await prisma.raw.ticket.create({
      data: { workspaceId: ws, number: 1, pipelineId: pl.id, stageId: st.id, contactId: ids["contact-unassigned"], title: "Broken" },
    });
    ids.ticket = tk.id;
    await fu("late on a ticket", new Date("2026-11-09T09:00:00Z"), { ticketId: tk.id, contactId: null });

    // A booking today (nobody has a staff resource: everyone's bookings show).
    const bk = await prisma.raw.appointment.create({
      data: { workspaceId: ws, contactId: ids["contact-unassigned"], service: "Cut", serviceAr: "قص", startAt: new Date("2026-11-10T13:00:00Z"), durationMin: 30, status: "confirmed", source: "self-booking", createdAt: ago(60) },
    });
    ids.booking = bk.id;
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.raw.ticket.deleteMany({ where: { workspaceId: { in: [ws, foreignWs] } } });
      await prisma.raw.workspace.deleteMany({ where: { id: { in: [ws, foreignWs] } } });
      await prisma.raw.user.deleteMany({ where: { id: { in: users } } });
      await prisma.onModuleDestroy();
    }
  });

  const home = (key: string): Promise<HomeDto> => svc.home(ws, { userId: ids[key] }, NOW);

  it("waiting conversations are unanswered, visible and need a person", async () => {
    const sami = ok((await home("sami")).needsPerson.waitingConversations);
    // sami-ai (AI on, not paused, not escalated), pending, closed and staff-last are out;
    // the paused one is in, waiting since the customer's message after the takeover.
    expect(sami.items.map((r) => r.id)).toEqual([ids["sami-wait"], ids["sami-paused"], ids["sami-esc"]]);
    expect(sami.total).toBe(3);
    expect(sami.items[1].waitingSince).toBe(ago(150).toISOString());
  });

  it("home lists only permitted records", async () => {
    const sami = await home("sami");
    const body = JSON.stringify(sami);
    for (const hidden of ["unassigned", "badr", "badr-res", "foreign"]) expect({ hidden, leaked: body.includes(ids[hidden]) }).toEqual({ hidden, leaked: false });
    expect(sami.needsPerson.unassignedTickets).toEqual({ status: "forbidden" });
    expect(sami.today.bookings).toEqual({ status: "forbidden" });
    expect(ok(sami.needsPerson.lateFollowUps).items.map((f) => f.title)).toEqual(["late"]);

    const owner = await home("owner");
    expect(ok(owner.needsPerson.waitingConversations).items.map((r) => r.id)).toEqual([ids.unassigned]);
    expect(ok(owner.needsPerson.unassignedTickets).items.map((t) => t.id)).toEqual([ids.ticket]);
    expect(ok(owner.today.bookings).map((b) => b.id)).toEqual([ids.booking]);
    expect(JSON.stringify(owner)).not.toContain(ids.foreign);
  });

  it("today and tomorrow use local days", async () => {
    const sami = await home("sami");
    expect(ok(sami.today.followUps).map((f) => f.title)).toEqual(["today 23:30"]);
    expect(ok(sami.tomorrow.followUps).map((f) => f.title)).toEqual(["tomorrow 00:10"]);
  });

  it("away summary counts agent work since last seen", async () => {
    const sami = ok((await home("sami")).away);
    // AI replies since he looked (6 h): sami-ai (5 h) and sami-res; Badr's are hidden.
    expect(sami).toMatchObject({ aiReplies: 2, aiResolved: 1, agentBookings: null, autoTickets: null });
    expect(sami.conversations.map((c) => c.id)).toEqual([ids["sami-res"]]);
    const owner = ok((await home("owner")).away);
    expect(owner).toMatchObject({ since: new Date(NOW.getTime() - 24 * 3_600_000).toISOString(), aiReplies: 4, aiResolved: 2, agentBookings: 1, autoTickets: 0 });
    expect(owner.conversations.map((c) => c.id)).toEqual([ids["badr-res"], ids["sami-res"]]);

    await svc.seen(ws, { userId: ids.owner }, NOW);
    const row = await prisma.raw.workspaceMember.findFirst({ where: { workspaceId: ws, userId: ids.owner } });
    expect(row?.homeSeenAt?.toISOString()).toBe(NOW.toISOString());
    expect(ok((await home("owner")).away)).toMatchObject({ since: NOW.toISOString(), aiReplies: 0, aiResolved: 0 });
  });

  it("day-1 home shows until dismissed or set up", async () => {
    // Sami can only use the inbox step, and a staff reply exists.
    expect((await home("sami")).day1).toEqual({ show: false, steps: [{ key: "first_reply", done: true, href: "#/inbox" }] });
    const owner = await home("owner");
    expect(owner.day1.show).toBe(true);
    expect(owner.day1.steps.find((s) => s.key === "invite_team")?.done).toBe(true);
    expect(owner.day1.steps.find((s) => s.key === "connect_channel")?.done).toBe(false);
    await svc.dismissDay1(ws, { userId: ids.owner }, NOW);
    expect((await home("owner")).day1.show).toBe(false);
    expect((await home("amal")).day1.show).toBe(true); // per member
  });
});
