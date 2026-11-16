import { ExecutionContext, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { makeFakePrisma } from "../channels/test-prisma";
import { PermissionGuard } from "../permissions/permission.guard";
import { PermissionService } from "../permissions/permission.service";
import { buildTicketWhere } from "./ticket-filter";
import { TicketsController } from "./tickets.controller";
import { CreateFromConversationDto, CreateTicketDto, ListTicketsQuery, ResolveTicketDto, UpdateTicketDto } from "./tickets.dto";
import { TicketsService } from "./tickets.service";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-tickets-support-spec";

const WS = "ws1";
const NOW = new Date("2026-11-16T12:00:00.000Z");
const H = 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

async function errOf(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

function world(opts: { kind?: string; stages?: any[] } = {}) {
  const stages = opts.stages ?? [
    { id: "s-open", workspaceId: WS, pipelineId: "pl", key: "open", label: "Open", order: 0, isTerminal: false, isWon: false, slaMinutes: 120 },
    { id: "s-done", workspaceId: WS, pipelineId: "pl", key: "resolved", label: "Resolved", order: 5, isTerminal: true, isWon: true, slaMinutes: null },
    { id: "s-won2", workspaceId: WS, pipelineId: "pl", key: "won_late", label: "Won late", order: 9, isTerminal: true, isWon: true, slaMinutes: null },
    { id: "s-lost", workspaceId: WS, pipelineId: "pl", key: "closed", label: "Closed", order: 4, isTerminal: true, isWon: false, slaMinutes: null },
  ];
  const prisma = makeFakePrisma({
    workspace: [{ id: WS, timezone: "Asia/Riyadh" }, { id: "ws2", timezone: "Asia/Riyadh" }],
    pipeline: [{ id: "pl", workspaceId: WS, kind: opts.kind ?? "support", archivedAt: null, agentCanMove: true, assignsConversations: false }],
    ticketStage: stages,
    contact: [
      { id: "ct", workspaceId: WS, name: "Lina", lifecycle: "lead" },
      { id: "ct2", workspaceId: WS, name: "Omar", lifecycle: "lead" },
    ],
    conversation: [{ id: "cv", workspaceId: WS, contactId: "ct", channel: "whatsapp", assigneeId: null }],
    workspaceMember: [],
    ticket: [],
    ticketActivity: [],
    appointment: [],
  });
  const realtime = { emitToWorkspace: jest.fn() };
  const svc = new TicketsService(prisma, realtime as never);
  return { prisma, realtime, svc };
}

const ticket = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: WS,
  number: Number(id.replace(/\D/g, "")) || 1,
  pipelineId: "pl",
  stageId: "s-open",
  contactId: "ct",
  conversationId: null,
  ownerId: null,
  title: id,
  priority: "normal",
  category: null,
  slaDueAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  enteredStageAt: NOW,
  ...over,
});

describe("unknown priority or category is 400", () => {
  it("DTOs refuse unknown values with the key (create, update, from-conversation); null category passes", async () => {
    const cases: Array<[any, Record<string, unknown>]> = [
      [CreateTicketDto, { pipelineId: "p", stageId: "s", contactId: "c", title: "t" }],
      [UpdateTicketDto, {}],
      [CreateFromConversationDto, { pipelineId: "p", stageId: "s", title: "t" }],
    ];
    for (const [cls, base] of cases) {
      const bad1 = await validate(plainToInstance(cls, { ...base, priority: "medium" }));
      expect(bad1.flatMap((e) => Object.values(e.constraints ?? {}))).toEqual(["tickets.invalid_priority"]);
      const bad2 = await validate(plainToInstance(cls, { ...base, category: "billing" }));
      expect(bad2.flatMap((e) => Object.values(e.constraints ?? {}))).toEqual(["tickets.invalid_category"]);
      expect(await validate(plainToInstance(cls, { ...base, priority: "urgent", category: "complaint" }))).toEqual([]);
      expect(await validate(plainToInstance(cls, { ...base, category: null }))).toEqual([]);
    }
  });

  it("the service refuses them too (internal callers), and a null category clears it", async () => {
    const { svc, prisma } = world();
    const create = { pipelineId: "pl", stageId: "s-open", contactId: "ct", title: "x" };
    const e1 = await errOf(svc.createTicket(WS, { ...create, priority: "medium" }));
    expect(e1.getResponse()).toEqual({ statusCode: 400, message: "tickets.invalid_priority" });
    const e2 = await errOf(svc.createFromConversation(WS, "cv", { pipelineId: "pl", stageId: "s-open", title: "x", category: "billing" }));
    expect(e2.getResponse()).toEqual({ statusCode: 400, message: "tickets.invalid_category" });
    expect(prisma.db.ticket).toHaveLength(0);

    const t = await svc.createFromConversation(WS, "cv", { pipelineId: "pl", stageId: "s-open", title: "x", priority: "high", category: "complaint" });
    expect(prisma.db.ticket[0]).toMatchObject({ priority: "high", category: "complaint", conversationId: "cv" });
    const e3 = await errOf(svc.updateTicket(WS, t.id, { priority: "URGENT" }));
    expect(e3.getStatus()).toBe(400);
    await svc.updateTicket(WS, t.id, { category: null });
    expect(prisma.db.ticket[0]).toMatchObject({ priority: "high", category: null });
    // Legacy rows (no priority written) read "normal".
    await svc.createTicket(WS, create);
    expect(prisma.db.ticket[1]).toMatchObject({ priority: "normal", category: null });
  });
});

describe("ticket filters ignore unknown values", () => {
  it("unknown priority/category entries are dropped; an unknown sla adds nothing; the query DTO accepts them", async () => {
    expect(buildTicketWhere(WS, { priority: "nope", category: "billing", sla: "late" }, "UTC", NOW)).toEqual({ workspaceId: WS });
    expect(buildTicketWhere(WS, { priority: "high,nope" }, "UTC", NOW)).toEqual({ workspaceId: WS, priority: { in: ["high"] } });
    expect(await validate(plainToInstance(ListTicketsQuery, { priority: "x", category: "y", sla: "z" }))).toEqual([]);
    const { svc } = world();
    await expect(svc.listTickets(WS, { view: "table", priority: "nope", sla: "whenever" })).resolves.toMatchObject({ total: 0 });
  });

  it("repeated filter params (arrays) are tolerated and joined, never a 400 (M4)", async () => {
    const q = plainToInstance(ListTicketsQuery, {
      priority: ["high", "urgent"],
      category: ["complaint", "nope"],
      sla: ["overdue"],
    });
    expect(await validate(q, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    expect(buildTicketWhere(WS, q, "UTC", NOW)).toEqual({
      workspaceId: WS,
      priority: { in: ["urgent", "high"] },
      category: { in: ["complaint"] },
      AND: [{ slaDueAt: { lt: NOW }, stage: { isTerminal: false } }],
    });
    // Two different sla values join into an unknown value: ignored.
    expect(buildTicketWhere(WS, { sla: ["overdue", "none"] }, "UTC", NOW)).toEqual({ workspaceId: WS });
    // Odd shapes (an object from `?priority[a]=b`) are ignored too.
    expect(buildTicketWhere(WS, { priority: { a: "high" } as never, sla: { x: 1 } as never }, "UTC", NOW)).toEqual({
      workspaceId: WS,
    });
  });
});

describe("ticket list filters and sorts by priority, category and sla", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "setTimeout", "setInterval"] });
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  function seeded() {
    const w = world();
    w.prisma.db.ticket.push(
      ticket("t1", { priority: "low", category: "complaint", slaDueAt: at(-H) }), // overdue
      ticket("t2", { priority: "urgent", category: "other", slaDueAt: at(2 * H) }), // due soon
      ticket("t3", { priority: "high", slaDueAt: at(48 * H) }), // on track
      ticket("t4", { priority: "normal" }), // no SLA
      ticket("t5", { priority: "urgent", stageId: "s-done", slaDueAt: at(-H) }), // terminal: not overdue
      ticket("t6", { priority: "high", category: "complaint", slaDueAt: at(24 * H) }), // due soon (edge)
    );
    return w;
  }
  const ids = (r: any) => r.items.map((t: any) => t.id);

  it("filters: priority CSV, category CSV, sla=overdue|due_soon|none", async () => {
    const { svc } = seeded();
    expect(ids(await svc.listTickets(WS, { view: "table", sort: "createdAt", dir: "asc", priority: "urgent,high" }))).toEqual(["t2", "t3", "t5", "t6"]);
    expect(ids(await svc.listTickets(WS, { view: "table", sort: "createdAt", dir: "asc", category: "complaint" }))).toEqual(["t1", "t6"]);
    expect(ids(await svc.listTickets(WS, { view: "table", sort: "createdAt", dir: "asc", sla: "overdue" }))).toEqual(["t1"]);
    expect(ids(await svc.listTickets(WS, { view: "table", sort: "createdAt", dir: "asc", sla: "due_soon" }))).toEqual(["t2", "t6"]);
    expect(ids(await svc.listTickets(WS, { view: "table", sort: "createdAt", dir: "asc", sla: "none" }))).toEqual(["t4"]);
    // The kanban shares the builder.
    expect(ids(await svc.listTickets(WS, { sla: "overdue" }))).toEqual(["t1"]);
    const r: any = await svc.listTickets(WS, { view: "table", sla: "overdue" });
    expect(r.total).toBe(1);
    expect(r.items[0]).toMatchObject({ priority: "low", category: "complaint", slaDueAt: at(-H), channel: null, attachmentCount: 0 });
  });

  it("sort=slaDueAt puts nulls last in both directions", async () => {
    const { svc } = seeded();
    expect(ids(await svc.listTickets(WS, { view: "table", sort: "slaDueAt", dir: "asc" }))).toEqual(["t1", "t5", "t2", "t6", "t3", "t4"]);
    expect(ids(await svc.listTickets(WS, { view: "table", sort: "slaDueAt", dir: "desc" }))).toEqual(["t3", "t6", "t2", "t5", "t1", "t4"]);
  });

  it("sort=priority is urgent -> low (desc) and low -> urgent (asc), id within a rank", async () => {
    const { svc } = seeded();
    expect(ids(await svc.listTickets(WS, { view: "table", sort: "priority", dir: "desc" }))).toEqual(["t5", "t2", "t6", "t3", "t4", "t1"]);
    expect(ids(await svc.listTickets(WS, { view: "table", sort: "priority", dir: "asc" }))).toEqual(["t1", "t4", "t3", "t6", "t2", "t5"]);
  });

  it("cursor pages are stable under a new insert (slaDueAt and priority)", async () => {
    // Each insert sorts before the first page's cursor (an earlier due date; an
    // urgent ticket with a higher id, ids run desc inside a rank).
    for (const [sort, dir, expected, early] of [
      ["slaDueAt", "asc", ["t1", "t5", "t2", "t6", "t3", "t4"], ticket("t0", { priority: "low", slaDueAt: at(-5 * H) })],
      ["priority", "desc", ["t5", "t2", "t6", "t3", "t4", "t1"], ticket("t9", { priority: "urgent" })],
    ] as const) {
      const { svc, prisma } = seeded();
      const seen: string[] = [];
      let cursor: string | undefined;
      let first = true;
      for (;;) {
        const page: any = await svc.listTickets(WS, { view: "table", sort, dir, limit: 2, cursor });
        seen.push(...ids(page));
        if (first) {
          // A new ticket that sorts before the cursor never shifts the next pages.
          prisma.db.ticket.push({ ...early });
          first = false;
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect({ sort, seen }).toEqual({ sort, seen: [...expected] });
    }
  });
});

describe("resolve", () => {
  it("resolve moves to the first won terminal stage with the note", async () => {
    const { svc, prisma, realtime } = world({ kind: "leads" });
    prisma.db.ticket.push(ticket("t1", { conversationId: "cv" }));
    const out: any = await svc.resolveTicket(WS, "t1", { note: "  Replaced the filter.  " }, undefined);
    expect(prisma.db.ticket[0].stageId).toBe("s-done"); // lowest order among won terminal stages
    expect(prisma.db.ticket[0].closedAt).toBeInstanceOf(Date);
    const acts = prisma.db.ticketActivity.filter((a: any) => a.ticketId === "t1" && a.kind === "won");
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ fromStage: "open", toStage: "resolved", note: "Replaced the filter." });
    // Lead lifecycle sync ran (leads pipeline): the contact became a customer.
    expect(prisma.db.contact.find((c: any) => c.id === "ct").lifecycle).toBe("customer");
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(WS, "ticket.moved", expect.objectContaining({ toStageId: "s-done" }));
    // The ticket DTO comes back.
    expect(out).toMatchObject({ id: "t1", stageId: "s-done", channel: { kind: "whatsapp" }, attachmentCount: 0 });
  });

  it("resolve on a closed ticket is 409", async () => {
    const { svc, prisma } = world();
    prisma.db.ticket.push(ticket("t1", { stageId: "s-lost" }));
    const e = await errOf(svc.resolveTicket(WS, "t1", {}, undefined));
    expect(e.getResponse()).toEqual({ statusCode: 409, message: "tickets.already_closed" });
    expect(prisma.db.ticketActivity).toHaveLength(0);
  });

  it("resolve racing a concurrent close is 409 already_closed, never Lost -> Won (M1)", async () => {
    const { svc, prisma } = world({ kind: "leads" });
    prisma.db.ticket.push(ticket("t1"));
    // Another agent closes the ticket as Lost after resolve's read, before its move.
    const find = prisma.ticketStage.findFirst;
    prisma.ticketStage.findFirst = jest.fn((a: any) => {
      if (a?.where?.isWon === true) prisma.db.ticket[0].stageId = "s-lost";
      return find(a);
    });
    const e = await errOf(svc.resolveTicket(WS, "t1", { note: "done" }, undefined));
    expect(e.getResponse()).toEqual({ statusCode: 409, message: "tickets.already_closed" });
    expect(prisma.db.ticket[0].stageId).toBe("s-lost");
    expect(prisma.db.ticketActivity.filter((x: any) => x.kind === "won")).toHaveLength(0);
    expect(prisma.db.contact.find((c: any) => c.id === "ct").lifecycle).toBe("lead");
  });

  describe("resolve conflicts re-read the ticket (final review M3)", () => {
    const stages = [
      { id: "s-open", workspaceId: WS, pipelineId: "pl", key: "open", label: "Open", order: 0, isTerminal: false, isWon: false, slaMinutes: 120 },
      { id: "s-prog", workspaceId: WS, pipelineId: "pl", key: "in_progress", label: "In progress", order: 1, isTerminal: false, isWon: false, slaMinutes: 1440 },
      { id: "s-done", workspaceId: WS, pipelineId: "pl", key: "resolved", label: "Resolved", order: 5, isTerminal: true, isWon: true, slaMinutes: null },
      { id: "s-lost", workspaceId: WS, pipelineId: "pl", key: "closed", label: "Closed", order: 4, isTerminal: true, isWon: false, slaMinutes: null },
    ];
    /** Run `race` when the move's conditional write (updateMany on stageId) is about to run, `times` times. */
    function raceAtWrite(prisma: any, race: () => void, times = 1) {
      const um = prisma.ticket.updateMany;
      let left = times;
      prisma.ticket.updateMany = jest.fn((a: any) => {
        if (left > 0 && a?.where?.stageId !== undefined) {
          left--;
          race();
        }
        return um(a);
      });
    }

    it("moved to another open stage meanwhile (at the conditional write): one retry resolves it", async () => {
      const { svc, prisma } = world({ stages });
      prisma.db.ticket.push(ticket("t1"));
      raceAtWrite(prisma, () => (prisma.db.ticket[0].stageId = "s-prog"));
      const out: any = await svc.resolveTicket(WS, "t1", { note: "fixed" }, undefined);
      expect(out.stageId).toBe("s-done");
      const won = prisma.db.ticketActivity.filter((a: any) => a.kind === "won");
      expect(won).toHaveLength(1);
      expect(won[0]).toMatchObject({ fromStage: "in_progress", toStage: "resolved", note: "fixed" });
    });

    it("closed meanwhile at the conditional write -> 409 already_closed, nothing written", async () => {
      const { svc, prisma } = world({ stages });
      prisma.db.ticket.push(ticket("t1"));
      raceAtWrite(prisma, () => (prisma.db.ticket[0].stageId = "s-lost"));
      const e = await errOf(svc.resolveTicket(WS, "t1", {}, undefined));
      expect(e.getResponse()).toEqual({ statusCode: 409, message: "tickets.already_closed" });
      expect(prisma.db.ticket[0].stageId).toBe("s-lost");
      expect(prisma.db.ticketActivity).toHaveLength(0);
    });

    it("moved again during the retry -> 409 tickets.stage_changed", async () => {
      const { svc, prisma } = world({ stages });
      prisma.db.ticket.push(ticket("t1"));
      let flip = false;
      raceAtWrite(
        prisma,
        () => {
          flip = !flip;
          prisma.db.ticket[0].stageId = flip ? "s-prog" : "s-open";
        },
        2,
      );
      const e = await errOf(svc.resolveTicket(WS, "t1", {}, undefined));
      expect(e.getResponse()).toEqual({ statusCode: 409, message: "tickets.stage_changed" });
      expect(prisma.db.ticketActivity).toHaveLength(0);
    });
  });

  it("a pipeline with no won terminal stage -> 409 tickets.no_resolved_stage; foreign id -> 404", async () => {
    const { svc, prisma } = world({
      stages: [
        { id: "s-open", workspaceId: WS, pipelineId: "pl", key: "open", order: 0, isTerminal: false, isWon: false },
        { id: "s-lost", workspaceId: WS, pipelineId: "pl", key: "lost", order: 1, isTerminal: true, isWon: false },
      ],
    });
    prisma.db.ticket.push(ticket("t1"), ticket("t9", { workspaceId: "ws2" }));
    const e = await errOf(svc.resolveTicket(WS, "t1", { note: "x" }, undefined));
    expect(e.getResponse()).toEqual({ statusCode: 409, message: "tickets.no_resolved_stage" });
    await expect(svc.resolveTicket(WS, "t9", {}, undefined)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the note is at most 2000 characters and no other body field is accepted", async () => {
    expect(await validate(plainToInstance(ResolveTicketDto, { note: "x".repeat(2000) }))).toEqual([]);
    expect(await validate(plainToInstance(ResolveTicketDto, { note: "x".repeat(2001) }))).not.toEqual([]);
    const extra = await validate(plainToInstance(ResolveTicketDto, { version: 3 }), { whitelist: true, forbidNonWhitelisted: true });
    expect(extra).not.toEqual([]);
  });
});

describe("ticket booking cards list upcoming pending and confirmed bookings of the contact", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "setTimeout", "setInterval"] });
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  const appt = (id: string, over: Record<string, unknown>) => ({
    id,
    workspaceId: WS,
    contactId: "ct",
    staffId: "u1",
    service: "Cleaning",
    serviceAr: "تنظيف",
    startAt: at(H),
    durationMin: 30,
    status: "pending",
    source: "self-booking",
    hjzSyncError: null,
    note: "private",
    ...over,
  });

  it("pending/confirmed from one day back, soonest first; others, other contacts and foreign tickets excluded", async () => {
    const { svc, prisma } = world();
    prisma.db.ticket.push(ticket("t1"), ticket("t9", { workspaceId: "ws2" }));
    prisma.db.appointment.push(
      appt("a-later", { status: "confirmed", startAt: at(48 * H) }),
      appt("a-soon", { status: "pending", startAt: at(H) }),
      appt("a-yesterday", { status: "confirmed", startAt: at(-20 * H) }),
      appt("a-old", { status: "pending", startAt: at(-25 * H) }),
      appt("a-done", { status: "completed" }),
      appt("a-cancel", { status: "cancelled" }),
      appt("a-noshow", { status: "no-show" }),
      appt("a-other", { contactId: "ct2" }),
      appt("a-ws2", { workspaceId: "ws2" }),
    );
    const r = await svc.bookingsForTicket(WS, "t1", undefined);
    expect(r.items.map((b) => b.id)).toEqual(["a-yesterday", "a-soon", "a-later"]);
    expect(r.items[1]).toEqual({
      id: "a-soon",
      startAt: at(H),
      durationMin: 30,
      status: "pending",
      service: "Cleaning",
      serviceAr: "تنظيف",
      staffId: "u1",
      source: "self-booking",
      hjzSyncError: null,
    });
    await expect(svc.bookingsForTicket(WS, "t9", undefined)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the service also needs tickets.view; bookings.view missing -> 403 through the guard", async () => {
    const prisma = makeFakePrisma({
      role: [
        { id: "r-books", workspaceId: WS, key: null, isSystem: false, name: "B", nameAr: "B", permissions: { bookings: ["view"] }, conversationVisibility: "all" },
      ],
      workspaceMember: [{ id: "wm", workspaceId: WS, userId: "u", role: "custom", roleId: "r-books" }],
      ticket: [ticket("t1")],
    });
    const perm = new PermissionService(prisma);
    const svc = new TicketsService(prisma, { emitToWorkspace: jest.fn() } as never, undefined, undefined, perm);
    const e = await errOf(svc.bookingsForTicket(WS, "t1", { userId: "u" }));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getResponse()).toMatchObject({ permission: "tickets.view" });

    const effective = jest.fn().mockResolvedValue({ key: null, permissions: { tickets: ["view"] }, conversationVisibility: "all" });
    const guard = new PermissionGuard(new Reflector(), { effective, can: (eff: any, p: string) => !!eff.permissions[p.split(".")[0]]?.includes(p.split(".")[1]) } as never);
    const ctx = {
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => ({ user: { sub: "u", workspaceId: WS } }) }),
      getHandler: () => TicketsController.prototype.bookings,
      getClass: () => TicketsController,
    } as unknown as ExecutionContext;
    const g = await errOf(guard.canActivate(ctx));
    expect(g).toBeInstanceOf(ForbiddenException);
    expect(g.getResponse()).toMatchObject({ message: "Missing permission", permission: "bookings.view" });
  });
});

describe("PATCH /tickets/:id returns the full ticket (final review M2)", () => {
  it("activities (fresh owner/value entries), pipeline, channel and attachmentCount, under the viewer", async () => {
    const { svc, prisma } = world();
    prisma.db.workspaceMember.push({ id: "wm", workspaceId: WS, userId: "u2", role: "agent" });
    prisma.db.ticket.push(ticket("t1", { conversationId: "cv", value: 10 }));
    (prisma.db.ticketAttachment ??= []).push({ id: "a1", workspaceId: WS, ticketId: "t1", mediaId: "m1", source: "staff", createdAt: NOW });
    const ctrl = new TicketsController(svc, {} as never);
    const out: any = await ctrl.updateTicket(WS, "actor", "t1", { ownerId: "u2", value: 25, priority: "high" }, undefined);
    expect(out).toMatchObject({
      id: "t1",
      ownerId: "u2",
      value: 25,
      priority: "high",
      pipeline: expect.objectContaining({ id: "pl" }),
      channel: { kind: "whatsapp", channelId: null, displayName: null },
      attachmentCount: 1,
    });
    expect(out.activities.map((a: any) => a.kind).sort()).toEqual(["owner_changed", "value_changed"]);
  });
});
