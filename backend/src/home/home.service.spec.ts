import type { Prisma } from "@prisma/client";
import { day1View, DAY1_STEPS } from "./day1-steps";
import { HomeService, homeDays, iso } from "./home.service";
import type { SectionTx } from "../insights/insights.service";

/**
 * SP-11 working home over a fake database: statements are recognised by their
 * `/* home:<name> *\/` tag and answered with canned rows. The real SQL runs in
 * `home.db.spec.ts`.
 */

const WS = "ws1";
const ME = "u-me";
const NOW = new Date("2026-11-10T09:00:00Z"); // 12:00 Riyadh
const tagOf = (sql: Prisma.Sql) => /home:(\w+)/.exec(sql.strings[0])?.[1] ?? "?";
const text = (sql: Prisma.Sql) => sql.strings.join("?");

const ALL = [
  "conversations.view",
  "conversations.create",
  "tickets.view",
  "contacts.view",
  "bookings.view",
  "bookings.manage",
  "channels.create",
  "knowledge.create",
  "members.create",
  "pipelines.update",
];

const SCHEMA_ROWS = [
  { table: "Ticket", column: "slaDueAt" },
  { table: "Appointment", column: "resourceId" },
  { table: "StaffResource", column: "userId" },
  { table: "Service", column: "id" },
  { table: "KnowledgeSource", column: "status" },
];

function rowsFor(over: Record<string, unknown[]> = {}): Record<string, unknown[]> {
  return {
    waitingConversations: [
      { id: "cv-mine", contactName: "Lina", channel: "whatsapp", waitingSince: new Date("2026-11-10T07:00:00Z"), assigneeId: ME, escalated: false, total: 2 },
      { id: "cv-unassigned", contactName: "Omar", channel: "whatsapp", waitingSince: new Date("2026-11-10T08:00:00Z"), assigneeId: null, escalated: true, total: 2 },
    ],
    lateFollowUps: [{ id: "a-late", title: "Call back", kind: "call", dueAt: new Date("2026-11-08T10:00:00Z"), contactId: "ct1", ticketId: null, total: 1 }],
    unassignedTickets: [
      { id: "tk-1", number: 7, title: "Broken", createdAt: new Date("2026-11-09T10:00:00Z"), contactName: "Lina", slaDueAt: new Date("2026-11-10T12:00:00Z"), priority: "high", total: 1 },
    ],
    dayFollowUps: [
      { day: "today", id: "a-today", title: "Quote", kind: "call", dueAt: new Date("2026-11-10T20:30:00Z"), contactId: "ct1", ticketId: null },
      { day: "tomorrow", id: "a-tomorrow", title: "Visit", kind: "visit", dueAt: new Date("2026-11-10T21:10:00Z"), contactId: "ct1", ticketId: null },
    ],
    dayBookings: [
      { day: "today", id: "bk-1", startAt: new Date("2026-11-10T13:00:00Z"), durationMin: 30, service: "Cut", serviceAr: "قص", status: "confirmed", contactName: "Lina" },
    ],
    dayTicketsDue: [
      { day: "tomorrow", id: "tk-2", number: 8, title: "SLA", createdAt: new Date("2026-11-09T10:00:00Z"), slaDueAt: new Date("2026-11-11T06:00:00Z"), priority: "urgent", contactName: null },
    ],
    away: [
      {
        aiReplies: 4,
        aiResolved: 2,
        agentBookings: 1,
        autoTickets: 3,
        rows: [
          { id: "cv-ai-1", contactName: "Sara", resolvedAt: "2026-11-10T06:00:00.000" },
          { id: "cv-ai-2", contactName: "Nour", resolvedAt: "2026-11-10T05:00:00" },
        ],
      },
    ],
    day1: [{ connect_channel: true, add_knowledge: false, invite_team: true, set_pipeline: false, add_services: false, first_reply: true }],
    ...over,
  };
}

interface BuildOpts {
  perms?: string[];
  scope?: Record<string, unknown>;
  rows?: Record<string, unknown[]>;
  /** Ids the bulk re-check says are openable (default: every id asked). */
  openable?: (kind: string, ids: string[]) => string[];
  schema?: unknown[] | Error;
  member?: { homeSeenAt: Date | null; homeDay1DismissedAt: Date | null } | null;
}

function build(o: BuildOpts = {}) {
  const rows = o.rows ?? rowsFor();
  const queried: Prisma.Sql[] = [];
  let calls = 0;
  const tx: SectionTx = {
    $executeRawUnsafe: jest.fn(async () => 0),
    $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
      calls += 1;
      queried.push(sql);
      const tag = tagOf(sql);
      if (tag === "schema") {
        if (o.schema instanceof Error) throw o.schema;
        return (o.schema ?? SCHEMA_ROWS) as never;
      }
      if (tag === "openable") {
        // values: per branch [kind, ws, ids, (scope)]
        const out: { kind: string; id: string }[] = [];
        for (let i = 0; i < sql.values.length; i++) {
          const v = sql.values[i];
          if (Array.isArray(v)) {
            const kind = String(sql.values[i - 2]);
            const keep = o.openable ? o.openable(kind, v as string[]) : (v as string[]);
            for (const id of keep) out.push({ kind, id });
          }
        }
        return out as never;
      }
      return (rows[tag] ?? []) as never;
    }) as never,
  };
  const member = o.member === undefined ? { homeSeenAt: new Date("2026-11-09T09:00:00Z"), homeDay1DismissedAt: null } : o.member;
  const prisma = {
    workspaceMember: {
      findUnique: jest.fn(async () => {
        calls += 1;
        return member ? { ...member, workspace: { timezone: "Asia/Riyadh" } } : null;
      }),
      updateMany: jest.fn(async () => ({ count: member ? 1 : 0 })),
    },
    workspace: { findUnique: jest.fn(async () => ((calls += 1), { timezone: "Asia/Riyadh" })) },
    $queryRaw: jest.fn(async () => {
      calls += 1;
      if (o.schema instanceof Error) throw o.schema;
      return (o.schema ?? SCHEMA_ROWS) as never;
    }),
    $transaction: jest.fn(async (fn: (t: SectionTx) => Promise<unknown>) => fn(tx)),
  };
  const perms = new Set(o.perms ?? ALL);
  const perm = {
    effective: jest.fn(async () => ({ perms })),
    can: jest.fn((eff: { perms: Set<string> } | null, p: string) => !!eff && eff.perms.has(p)),
    conversationScope: jest.fn(async () => o.scope ?? {}),
  };
  const svc = new HomeService(prisma as never, perm as never);
  return { svc, prisma, tx, queried, calls: () => calls };
}

const ok = <T>(s: { status: string; data?: T }): T => {
  if (s.status !== "ok") throw new Error(`section ${s.status}`);
  return s.data as T;
};

describe("HomeService", () => {
  it("home lists only permitted records", async () => {
    // Assigned-only agent: scope inside every conversation statement; a hidden
    // id that slipped through is dropped by id, from the total and from "away".
    const hidden = build({
      scope: { assigneeId: ME },
      rows: rowsFor({
        waitingConversations: [
          ...rowsFor().waitingConversations,
          { id: "cv-hidden", contactName: "X", channel: "whatsapp", waitingSince: new Date("2026-11-10T08:30:00Z"), assigneeId: null, escalated: false, total: 3 },
        ].map((r) => ({ ...(r as object), total: 3 })),
        away: [{ ...(rowsFor().away[0] as object), rows: [{ id: "cv-hidden", contactName: "X", resolvedAt: "2026-11-10T06:00:00" }, { id: "cv-ai-1", contactName: "Sara", resolvedAt: "2026-11-10T05:00:00" }] }],
      }),
      openable: (kind, ids) => ids.filter((id) => id !== "cv-hidden"),
    });
    const res = await hidden.svc.home(WS, { userId: ME }, NOW);
    const waiting = ok(res.needsPerson.waitingConversations);
    expect(waiting.items.map((r) => r.id)).toEqual(["cv-mine", "cv-unassigned"]);
    expect(waiting.total).toBe(2);
    expect(ok(res.away).conversations.map((c) => c.id)).toEqual(["cv-ai-1"]);
    expect(JSON.stringify(res)).not.toContain("cv-hidden");
    for (const sql of hidden.queried) {
      const t = text(sql);
      const reads = (t.match(/"Conversation" c\s/g) ?? []).length;
      expect({ tag: tagOf(sql), scoped: (t.match(/AND c\."assigneeId" = \?/g) ?? []).length }).toEqual({ tag: tagOf(sql), scoped: reads });
      // Every statement is bound to this workspace.
      // (The schema check reads information_schema only.)
      if (tagOf(sql) !== "?" && tagOf(sql) !== "schema") expect(sql.values).toContain(WS);
    }
    // Waiting = mine or unassigned.
    const w = hidden.queried.find((s) => tagOf(s) === "waitingConversations")!;
    expect(text(w)).toContain('(c."assigneeId" = ? OR c."assigneeId" IS NULL)');
    expect(w.values).toContain(ME);

    // Without tickets.view: no ticket lists, ticket-linked follow-ups hidden, no auto-ticket count.
    const noTickets = build({ perms: ALL.filter((p) => p !== "tickets.view") });
    const r2 = await noTickets.svc.home(WS, { userId: ME }, NOW);
    expect(r2.needsPerson.unassignedTickets).toEqual({ status: "forbidden" });
    expect(r2.today.ticketsDue).toEqual({ status: "forbidden" });
    expect(ok(r2.away).autoTickets).toBeNull();
    for (const tag of ["lateFollowUps", "dayFollowUps"]) {
      expect(text(noTickets.queried.find((s) => tagOf(s) === tag)!)).toContain('AND a."ticketId" IS NULL');
    }
    expect(noTickets.queried.map(tagOf)).not.toContain("unassignedTickets");
    expect(noTickets.queried.find((s) => tagOf(s) === "openable")!.values).not.toContain("ticket");

    // Without bookings.view: no bookings at all.
    const noBookings = build({ perms: ALL.filter((p) => p !== "bookings.view") });
    const r3 = await noBookings.svc.home(WS, { userId: ME }, NOW);
    expect(r3.today.bookings).toEqual({ status: "forbidden" });
    expect(r3.tomorrow.bookings).toEqual({ status: "forbidden" });
    expect(ok(r3.away).agentBookings).toBeNull();
    expect(noBookings.queried.map(tagOf)).not.toContain("dayBookings");

    // Without conversations.view: no waiting list, no AI counts or rows.
    const noConv = build({ perms: ALL.filter((p) => p !== "conversations.view") });
    const r4 = await noConv.svc.home(WS, { userId: ME }, NOW);
    expect(r4.needsPerson.waitingConversations).toEqual({ status: "forbidden" });
    expect(ok(r4.away)).toMatchObject({ aiReplies: null, aiResolved: null, conversations: [] });

    // A record another workspace owns is not openable here: dropped.
    const foreign = build({ openable: (kind, ids) => ids.filter((id) => id !== "tk-1" && id !== "bk-1") });
    const r5 = await foreign.svc.home(WS, { userId: ME }, NOW);
    expect(ok(r5.needsPerson.unassignedTickets)).toEqual({ total: 0, items: [] });
    expect(ok(r5.today.bookings)).toEqual([]);

    // The owner (visibility all) sees everything, with no assignee clause.
    const owner = build();
    const r6 = await owner.svc.home(WS, { userId: ME }, NOW);
    expect(ok(r6.needsPerson.waitingConversations).items).toHaveLength(2);
    expect(ok(r6.needsPerson.unassignedTickets).items[0]).toEqual({
      id: "tk-1",
      number: 7,
      title: "Broken",
      contactName: "Lina",
      createdAt: "2026-11-09T10:00:00.000Z",
      slaDueAt: "2026-11-10T12:00:00.000Z",
      priority: "high",
    });
    for (const sql of owner.queried) expect(text(sql)).not.toContain('AND c."assigneeId" = ?');

    // A non-member fails closed.
    const stranger = build({ perms: [] });
    const r7 = await stranger.svc.home(WS, { userId: "stranger" }, NOW);
    expect(r7.needsPerson.waitingConversations.status).toBe("forbidden");
    expect(r7.needsPerson.lateFollowUps.status).toBe("forbidden");
    expect(r7.day1).toEqual({ show: false, steps: [] });
  });

  it("waiting conversations are unanswered, visible and need a person", async () => {
    const b = build();
    await b.svc.home(WS, { userId: ME }, NOW);
    const t = text(b.queried.find((s) => tagOf(s) === "waitingConversations")!);
    // pending_customer / resolved / closed / spam excluded.
    expect(b.queried.find((s) => tagOf(s) === "waitingConversations")!.values).toEqual(
      expect.arrayContaining(["resolved", "closed", "spam", "pending_customer"]),
    );
    expect(t).toContain('c."status" NOT IN (');
    // AI-handled and not escalated: excluded.
    // AI-handled, not escalated, not paused: excluded; paused (staff took over): included.
    expect(t).toContain('(c."aiEnabled" = FALSE OR c."escalated" = TRUE OR c."aiPausedAt" IS NOT NULL)');
    // Latest message is the customer's: a customer message after the last reply.
    expect(t).toContain(`m."from" = 'them'`);
    expect(t).toContain(`m."createdAt" > COALESCE(b."lastReplyAt", '-infinity'::timestamp)`);
    // Oldest first.
    expect(t).toContain('ORDER BY w."waitingSince" ASC');
  });

  it("today and tomorrow use local days", async () => {
    const d = homeDays(NOW, "Asia/Riyadh");
    expect(d).toEqual({
      todayStart: new Date("2026-11-09T21:00:00Z"),
      tomorrowStart: new Date("2026-11-10T21:00:00Z"),
      tomorrowEnd: new Date("2026-11-11T21:00:00Z"),
    });
    // 23:30 local is today; 00:10 local is tomorrow.
    expect(new Date("2026-11-10T20:30:00Z") < d.tomorrowStart).toBe(true);
    expect(new Date("2026-11-10T21:10:00Z") >= d.tomorrowStart).toBe(true);
    const b = build();
    const res = await b.svc.home(WS, { userId: ME }, NOW);
    expect(ok(res.today.followUps).map((f) => f.id)).toEqual(["a-today"]);
    expect(ok(res.tomorrow.followUps).map((f) => f.id)).toEqual(["a-tomorrow"]);
    expect(ok(res.today.bookings).map((x) => x.id)).toEqual(["bk-1"]);
    expect(ok(res.tomorrow.ticketsDue).map((x) => x.id)).toEqual(["tk-2"]);
    const day = b.queried.find((s) => tagOf(s) === "dayFollowUps")!;
    expect(day.values).toEqual(expect.arrayContaining(["2026-11-09T21:00:00.000Z", "2026-11-10T21:00:00.000Z", "2026-11-11T21:00:00.000Z"]));
    const late = b.queried.find((s) => tagOf(s) === "lateFollowUps")!;
    expect(late.values).toContain("2026-11-09T21:00:00.000Z");
    expect(res.tz).toBe("Asia/Riyadh");
    expect(res.now).toBe(NOW.toISOString());
  });

  it("away summary counts agent work since last seen", async () => {
    const seen = build({ member: { homeSeenAt: new Date("2026-11-09T09:00:00Z"), homeDay1DismissedAt: null } });
    const res = await seen.svc.home(WS, { userId: ME }, NOW);
    expect(ok(res.away)).toEqual({
      since: "2026-11-09T09:00:00.000Z",
      aiReplies: 4,
      aiResolved: 2,
      agentBookings: 1,
      autoTickets: 3,
      conversations: [
        { id: "cv-ai-1", contactName: "Sara", resolvedAt: "2026-11-10T06:00:00.000Z" },
        { id: "cv-ai-2", contactName: "Nour", resolvedAt: "2026-11-10T05:00:00.000Z" },
      ],
    });
    const away = seen.queried.find((s) => tagOf(s) === "away")!;
    expect(away.values).toEqual(expect.arrayContaining(["2026-11-09T09:00:00.000Z", NOW.toISOString()]));
    // Counts under scope.
    const scoped = build({ scope: { assigneeId: ME } });
    await scoped.svc.home(WS, { userId: ME }, NOW);
    expect(text(scoped.queried.find((s) => tagOf(s) === "away")!)).toContain('AND c."assigneeId" = ?');

    // Never looked: the last 24 h.
    const never = build({ member: { homeSeenAt: null, homeDay1DismissedAt: null } });
    expect(ok((await never.svc.home(WS, { userId: ME }, NOW)).away).since).toBe("2026-11-09T09:00:00.000Z");

    // POST /home/seen moves it to now, for this member in this workspace only.
    expect(await seen.svc.seen(WS, { userId: ME }, NOW)).toEqual({ homeSeenAt: NOW.toISOString() });
    expect(seen.prisma.workspaceMember.updateMany).toHaveBeenCalledWith({ where: { workspaceId: WS, userId: ME }, data: { homeSeenAt: NOW } });
    // A bypass session has no member row: nothing is written.
    expect(await seen.svc.seen(WS, { userId: "admin", bypass: true }, NOW)).toEqual({ homeSeenAt: null });
    expect(seen.prisma.workspaceMember.updateMany).toHaveBeenCalledTimes(1);
  });

  it("day-1 home shows until dismissed or set up", async () => {
    const all = () => true;
    const partly = { connect_channel: true, add_knowledge: false, invite_team: true, set_pipeline: false, add_services: false, first_reply: true };
    const v = day1View(partly, all, { dismissedAt: null, hasServices: true });
    expect(v.show).toBe(true);
    expect(v.steps.map((s) => [s.key, s.done])).toEqual([
      ["connect_channel", true],
      ["add_knowledge", false],
      ["invite_team", true],
      ["set_pipeline", false],
      ["add_services", false],
      ["first_reply", true],
    ]);
    expect(v.steps.map((s) => s.href)).toEqual(DAY1_STEPS.map((s) => s.href));
    // Dismissed: hidden.
    expect(day1View(partly, all, { dismissedAt: new Date(), hasServices: true }).show).toBe(false);
    // Everything done: hidden.
    const allDone = Object.fromEntries(DAY1_STEPS.map((s) => [s.key, true]));
    expect(day1View(allDone, all, { dismissedAt: null, hasServices: true }).show).toBe(false);
    // Steps the member cannot use are omitted (a viewer: no setup screens at all).
    const viewer = day1View(partly, (p) => p === "conversations.create", { dismissedAt: null, hasServices: true });
    expect(viewer.steps.map((s) => s.key)).toEqual(["first_reply"]);
    expect(viewer.show).toBe(false); // the only step left is done
    expect(day1View(partly, () => false, { dismissedAt: null, hasServices: true })).toEqual({ show: false, steps: [] });

    // Through the service: from data, per member.
    const b = build({ member: { homeSeenAt: null, homeDay1DismissedAt: null } });
    const res = await b.svc.home(WS, { userId: ME }, NOW);
    expect(res.day1.show).toBe(true);
    expect(res.day1.steps.find((s) => s.key === "add_knowledge")).toEqual({ key: "add_knowledge", done: false, href: "#/settings?tab=aiKnowledge" });
    const dismissed = build({ member: { homeSeenAt: null, homeDay1DismissedAt: new Date("2026-11-01T00:00:00Z") } });
    expect((await dismissed.svc.home(WS, { userId: ME }, NOW)).day1.show).toBe(false);
    expect(await b.svc.dismissDay1(WS, { userId: ME }, NOW)).toEqual({ dismissedAt: NOW.toISOString() });
    expect(b.prisma.workspaceMember.updateMany).toHaveBeenCalledWith({ where: { workspaceId: WS, userId: ME }, data: { homeDay1DismissedAt: NOW } });
  });

  it("home checks records in bulk", async () => {
    // 30 record rows: 10 waiting, 10 unassigned tickets, 10 bookings.
    const many = (n: number, f: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => f(i));
    const b = build({
      rows: rowsFor({
        waitingConversations: many(10, (i) => ({ id: `cv${i}`, contactName: "C", channel: "whatsapp", waitingSince: new Date(NOW.getTime() - i * 60_000), assigneeId: null, escalated: false, total: 25 })),
        unassignedTickets: many(10, (i) => ({ id: `tk${i}`, number: i, title: "T", createdAt: NOW, contactName: null, slaDueAt: null, priority: null, total: 12 })),
        dayBookings: many(10, (i) => ({ day: i % 2 ? "tomorrow" : "today", id: `bk${i}`, startAt: NOW, durationMin: 30, service: "S", serviceAr: "S", status: "pending", contactName: null })),
      }),
    });
    const res = await b.svc.home(WS, { userId: ME }, NOW);
    expect(ok(res.needsPerson.waitingConversations).items).toHaveLength(10);
    expect(ok(res.needsPerson.waitingConversations).total).toBe(25);
    // One re-check statement for every record of every kind.
    expect(b.queried.filter((s) => tagOf(s) === "openable")).toHaveLength(1);
    expect(b.calls()).toBeLessThanOrEqual(12);
    // A second load reuses the schema check.
    const before = b.calls();
    await b.svc.home(WS, { userId: ME }, NOW);
    expect(b.calls() - before).toBeLessThanOrEqual(11);
  });

  it("home degrades without sp-09 or sp-10 columns", async () => {
    const b = build({ schema: [] });
    const res = await b.svc.home(WS, { userId: ME }, NOW);
    expect(res.today.ticketsDue).toEqual({ status: "unavailable" });
    expect(res.tomorrow.ticketsDue).toEqual({ status: "unavailable" });
    expect(b.queried.map(tagOf)).not.toContain("dayTicketsDue");
    // Unassigned tickets still list, oldest first, without SLA columns.
    const un = b.queried.find((s) => tagOf(s) === "unassignedTickets")!;
    expect(text(un)).not.toContain('t."slaDueAt"');
    expect(ok(res.needsPerson.unassignedTickets).items).toHaveLength(1);
    // Bookings: by staffId only (no StaffResource).
    const bk = b.queried.find((s) => tagOf(s) === "dayBookings")!;
    expect(text(bk)).not.toContain("StaffResource");
    expect(text(bk)).toContain('AND b."staffId" = ?');
    // No services step; no Service table read.
    expect(res.day1.steps.map((s) => s.key)).not.toContain("add_services");
    expect(text(b.queried.find((s) => tagOf(s) === "day1")!)).not.toContain('"Service"');

    // A failing schema check degrades the same way, without an error, and the
    // failure is remembered for 30 s (not re-queried on every load).
    const broken = build({ schema: new Error("permission denied for information_schema") });
    const r2 = await broken.svc.home(WS, { userId: ME }, NOW);
    expect(r2.today.ticketsDue).toEqual({ status: "unavailable" });
    expect(r2.needsPerson.waitingConversations.status).toBe("ok");
    const schemaQueries = () => broken.queried.filter((s) => tagOf(s) === "schema").length;
    expect(schemaQueries()).toBe(1);
    await broken.svc.home(WS, { userId: ME }, new Date(NOW.getTime() + 20_000));
    expect(schemaQueries()).toBe(1);
    await broken.svc.home(WS, { userId: ME }, new Date(NOW.getTime() + 31_000));
    expect(schemaQueries()).toBe(2);
    // The check runs with its own statement timeout.
    expect(broken.tx.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL statement_timeout = '2s'");

    // With both shipped, SLA ordering and staff resources are used.
    const full = build();
    await full.svc.home(WS, { userId: ME }, NOW);
    expect(text(full.queried.find((s) => tagOf(s) === "unassignedTickets")!)).toContain('t."slaDueAt" ASC NULLS LAST');
    expect(text(full.queried.find((s) => tagOf(s) === "dayBookings")!)).toContain('"StaffResource"');
  });

  it("day-1 knowledge step reads ready knowledge sources, or approved media before SP-21", async () => {
    const withKs = build();
    await withKs.svc.home(WS, { userId: ME }, NOW);
    const t1 = text(withKs.queried.find((s) => tagOf(s) === "day1")!);
    expect(t1).toContain(`FROM "KnowledgeSource" ks WHERE ks."workspaceId" = ? AND ks."status" = 'ready'`);
    expect(t1).not.toContain('"approvedForAgent"');
    // Table absent (SP-21 migration not applied yet): the Media rule, no error.
    const without = build({ schema: SCHEMA_ROWS.filter((r) => r.table !== "KnowledgeSource") });
    const res = await without.svc.home(WS, { userId: ME }, NOW);
    const t2 = text(without.queried.find((s) => tagOf(s) === "day1")!);
    expect(t2).not.toContain("KnowledgeSource");
    expect(t2).toContain('md."approvedForAgent" = TRUE');
    expect(res.day1.steps.map((s) => s.key)).toContain("add_knowledge");
  });

  it("a failed re-check fails record lists closed; a failed section is unavailable alone", async () => {
    const b = build();
    b.tx.$queryRaw = jest.fn(async (sql: Prisma.Sql) => {
      if (tagOf(sql) === "openable") throw new Error("boom");
      if (tagOf(sql) === "lateFollowUps") throw Object.assign(new Error("timeout"), { meta: { code: "57014" } });
      return (rowsFor()[tagOf(sql)] ?? []) as never;
    }) as never;
    const res = await b.svc.home(WS, { userId: ME }, NOW);
    expect(res.needsPerson.waitingConversations).toEqual({ status: "unavailable" });
    expect(res.needsPerson.unassignedTickets).toEqual({ status: "unavailable" });
    expect(res.needsPerson.lateFollowUps).toEqual({ status: "unavailable" });
    expect(res.today.bookings).toEqual({ status: "unavailable" });
    expect(res.away).toEqual({ status: "unavailable" });
    // Follow-ups are not records of a re-checked kind: still answered.
    expect(ok(res.today.followUps).map((f) => f.id)).toEqual(["a-today"]);
  });

  it("instants from json rows keep UTC", () => {
    expect(iso("2026-11-10T06:00:00")).toBe("2026-11-10T06:00:00.000Z");
    expect(iso("2026-11-10T06:00:00.5+00:00")).toBe("2026-11-10T06:00:00.500Z");
    expect(iso(new Date("2026-11-10T06:00:00Z"))).toBe("2026-11-10T06:00:00.000Z");
    expect(iso(null)).toBeNull();
  });
});
