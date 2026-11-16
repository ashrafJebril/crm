import type { Prisma } from "@prisma/client";
import { SALES_NOW, SALES_RANGE, ST, U } from "./__fixtures__/insights-world";
import { SALES_OWNER } from "./insights-expected";
import { FORMER_KEY } from "./insights-format";
import { SECTION_STATEMENT_TIMEOUT_MS } from "./insights-constants";
import { InsightsService, type SectionTx } from "./insights.service";
import { UNASSIGNED_KEY } from "./sales-metrics.sql";

/** `sales.<name>` / `support.<name>` tag a statement starts with. */
const tagOf = (sql: Prisma.Sql) => /insights:(\w+\.\w+)/.exec(sql.strings[0])?.[1] ?? "?";

/** Rows the real SQL returns for the owner over the fixture world (the DB
 *  spec proves the SQL; this proves the shaping), in no particular order. */
const OWNER_ROWS: Record<string, unknown[]> = {
  "sales.leads": [{ leads: 11 }],
  "sales.replied": [{ replied: 9 }],
  "sales.speedToReply": [{ median: 2400 }],
  "sales.waiting": [{ waiting: 3 }],
  "sales.won": [{ won: 3 }],
  "sales.speedDistribution": [
    { bucket: "not_replied", n: 3 },
    { bucket: "gt_24h", n: 2 },
    { bucket: "15_60m", n: 2 },
    { bucket: "lt_5m", n: 1 },
    { bucket: "5_15m", n: 1 },
    { bucket: "1_4h", n: 1 },
    { bucket: "4_24h", n: 1 },
  ],
  // The empty third week is absent from SQL; the service fills it.
  "sales.weekly": [
    { week: "2026-11-15", leads: 5, won: 1 },
    { week: "2026-11-08", leads: 6, won: 3 },
  ],
  "sales.sources": [
    { kind: "contact_source", key: "meta_lead_form", label: "meta_lead_form", leads: 1, won: 0 },
    { kind: "ad", key: "ad2", label: "Eid offer", leads: 1, won: 0 },
    { kind: "channel", key: "whatsapp", label: "whatsapp", leads: 5, won: 1 },
    { kind: "channel", key: "instagram", label: "instagram", leads: 1, won: 0 },
    { kind: "ad", key: "ad1", label: "Winter sale", leads: 2, won: 1 },
    { kind: "contact_source", key: "manual", label: "manual", leads: 1, won: 0 },
  ],
  "sales.funnel": [
    { stageId: ST.won, key: "won", label: "Won", labelAr: "فوز", isWon: true, isTerminal: true, order: 3, reached: 2 },
    { stageId: ST.lost, key: "lost", label: "Lost", labelAr: "خسارة", isWon: false, isTerminal: true, order: 2, reached: 4 },
    { stageId: ST.contacted, key: "contacted", label: "Contacted", labelAr: "تم التواصل", isWon: false, isTerminal: false, order: 1, reached: 5 },
    { stageId: ST.new, key: "new", label: "New", labelAr: "جديد", isWon: false, isTerminal: false, order: 0, reached: 10 },
  ],
  "sales.lostReasons": [
    { reasonId: null, label: null, labelAr: null, snapshot: "Too far", n: 1 },
    { reasonId: "lr-price", label: "Price", labelAr: "السعر", snapshot: null, n: 2 },
    { reasonId: null, label: null, labelAr: null, snapshot: null, n: 1 },
  ],
  "support.teamMembers": [
    { userId: U.owner, name: "Omar" },
    { userId: U.admin, name: "Amal" },
    { userId: U.agent, name: "Badr" },
    { userId: U.viewer, name: "Huda" },
    { userId: U.assigned, name: "Sami" },
  ],
  "sales.reps": [
    { key: U.agent, leads: 6, won: 2, lost: 2, done: 1, overdue: 2, dueToday: 1, median: 50400 },
    { key: U.assigned, leads: 3, won: 0, lost: 2, done: 1, overdue: 0, dueToday: 0, median: 750 },
    { key: U.owner, leads: 0, won: 0, lost: 0, done: 1, overdue: 0, dueToday: 0, median: null },
    { key: FORMER_KEY, leads: 1, won: 1, lost: 0, done: 0, overdue: 1, dueToday: 0, median: 3600 },
    { key: UNASSIGNED_KEY, leads: 1, won: 0, lost: 0, done: 0, overdue: 1, dueToday: 0, median: null },
  ],
};

const PIPELINES = [
  { id: "pl-support", workspaceId: "ws1", kind: "support", isDefault: false, archivedAt: null, createdAt: new Date("2026-09-01"), name: "Support", nameAr: "الدعم" },
  { id: "pl-leads-old", workspaceId: "ws1", kind: "leads", isDefault: false, archivedAt: new Date("2026-08-15"), createdAt: new Date("2026-08-01"), name: "Old", nameAr: "Old" },
  { id: "pl-deals", workspaceId: "ws1", kind: "deals", isDefault: true, archivedAt: null, createdAt: new Date("2026-09-02"), name: "Deals", nameAr: "Deals" },
  { id: "pl-leads", workspaceId: "ws1", kind: "leads", isDefault: false, archivedAt: null, createdAt: new Date("2026-09-03"), name: "Leads", nameAr: "العملاء" },
  { id: "pl-leads-2", workspaceId: "ws1", kind: "leads", isDefault: false, archivedAt: null, createdAt: new Date("2026-09-10"), name: "Leads 2", nameAr: "Leads 2" },
  { id: "pl-foreign", workspaceId: "ws2", kind: "leads", isDefault: true, archivedAt: null, createdAt: new Date("2026-01-01"), name: "B", nameAr: "B" },
];

function build(opts: { rows?: Record<string, unknown[]>; fail?: Record<string, unknown>; pipelines?: typeof PIPELINES; canTickets?: boolean } = {}) {
  const rows = opts.rows ?? OWNER_ROWS;
  const queried: Prisma.Sql[] = [];
  const tx: SectionTx = {
    $executeRawUnsafe: jest.fn(async () => 0),
    $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
      queried.push(sql);
      const tag = tagOf(sql);
      if (opts.fail && tag in opts.fail) throw opts.fail[tag];
      return (rows[tag] ?? []) as never;
    }) as never,
  };
  const pipelines = opts.pipelines ?? PIPELINES;
  const pick = (p: (typeof PIPELINES)[number]) => ({ id: p.id, name: p.name, nameAr: p.nameAr, kind: p.kind });
  const prisma = {
    workspace: { findUnique: jest.fn(async () => ({ timezone: "Asia/Riyadh", lang: "ar" })) },
    pipeline: {
      findFirst: jest.fn(async ({ where }: any) => {
        const hits = pipelines
          .filter((p) => p.workspaceId === where.workspaceId)
          .filter((p) => where.id === undefined || p.id === where.id)
          .filter((p) => where.kind === undefined || p.kind === where.kind)
          .filter((p) => where.archivedAt === undefined || p.archivedAt === where.archivedAt)
          .filter((p) => where.isDefault === undefined || p.isDefault === where.isDefault)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
        return hits[0] ? pick(hits[0]) : null;
      }),
    },
    $transaction: jest.fn(async (fn: (t: SectionTx) => Promise<unknown>) => fn(tx)),
  };
  const perm = {
    conversationScope: jest.fn(async () => ({})),
    viewerCan: jest.fn(async () => opts.canTickets ?? true),
  };
  return { svc: new InsightsService(prisma as never, perm as never), prisma, perm, tx, queried };
}

describe("InsightsService.sales", () => {
  it("shapes the SQL rows into the sales DTO (owner expectations)", async () => {
    const { svc } = build();
    const res = await svc.sales("ws1", SALES_RANGE, { userId: U.owner }, SALES_NOW);
    expect(res.range).toEqual({ from: "2026-11-08", to: "2026-11-28", tz: "Asia/Riyadh" });
    expect(res.pipeline).toEqual({ id: "pl-leads", name: "Leads", nameAr: "العملاء", kind: "leads" });
    expect(res.headline).toEqual({ status: "ok", data: SALES_OWNER.headline });
    expect(res.distribution).toEqual({ status: "ok", data: SALES_OWNER.distribution });
    expect(res.weekly).toEqual({ status: "ok", data: SALES_OWNER.weekly });
    expect(res.sources).toEqual({ status: "ok", data: SALES_OWNER.sources });
    expect(res.funnel).toEqual({ status: "ok", data: SALES_OWNER.funnel });
    expect(res.lostReasons).toEqual({ status: "ok", data: SALES_OWNER.lostReasons });
    expect(res.reps).toEqual({ status: "ok", data: SALES_OWNER.reps });
  });

  it("default pipeline is the first leads pipeline", async () => {
    // First non-archived leads pipeline by creation (not the archived older one, not the default deals one).
    expect((await build().svc.sales("ws1", SALES_RANGE, undefined, SALES_NOW)).pipeline.id).toBe("pl-leads");
    // No leads pipeline: the default pipeline.
    const noLeads = PIPELINES.filter((p) => p.kind !== "leads" || p.workspaceId !== "ws1");
    expect((await build({ pipelines: noLeads }).svc.sales("ws1", SALES_RANGE, undefined, SALES_NOW)).pipeline.id).toBe("pl-deals");
    // An explicit pipeline of this workspace, of any kind.
    expect((await build().svc.sales("ws1", { ...SALES_RANGE, pipelineId: "pl-leads-2" }, undefined, SALES_NOW)).pipeline.id).toBe("pl-leads-2");
    // Every statement reads the chosen pipeline.
    const b = build();
    await b.svc.sales("ws1", { ...SALES_RANGE, pipelineId: "pl-leads-2" }, undefined, SALES_NOW);
    const sales = b.queried.filter((x) => tagOf(x).startsWith("sales."));
    expect(sales).toHaveLength(11);
    for (const sql of sales) {
      expect({ tag: tagOf(sql), p: sql.values.includes("pl-leads-2") }).toEqual({ tag: tagOf(sql), p: true });
    }
  });

  it("foreign pipeline id is 404", async () => {
    const notFound = { response: { statusCode: 404, message: "insights.pipeline_not_found" } };
    const { svc, prisma } = build();
    await expect(svc.sales("ws1", { ...SALES_RANGE, pipelineId: "pl-foreign" }, undefined, SALES_NOW)).rejects.toMatchObject(notFound);
    await expect(svc.sales("ws1", { ...SALES_RANGE, pipelineId: "nope" }, undefined, SALES_NOW)).rejects.toMatchObject(notFound);
    await expect(svc.sales("ws1", { ...SALES_RANGE, pipelineId: ["pl-leads", "pl-leads"] }, undefined, SALES_NOW)).rejects.toMatchObject(notFound);
    // A workspace with no pipeline at all.
    await expect(build({ pipelines: [] }).svc.sales("ws1", SALES_RANGE, undefined, SALES_NOW)).rejects.toMatchObject(notFound);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("ticket sections are forbidden without tickets.view", async () => {
    const { svc, prisma, perm } = build({ canTickets: false });
    const viewer = { userId: "reports-only" };
    const res = await svc.sales("ws1", SALES_RANGE, viewer, SALES_NOW);
    expect(perm.viewerCan).toHaveBeenCalledWith("ws1", viewer, "tickets.view");
    for (const k of ["headline", "distribution", "weekly", "sources", "funnel", "lostReasons", "reps"] as const) {
      expect({ k, s: res[k] }).toEqual({ k, s: { status: "forbidden" } });
    }
    expect(res.pipeline.id).toBe("pl-leads");
    // Nothing is read.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    // The range and pipeline are still validated.
    await expect(svc.sales("ws1", { from: "x" }, viewer, SALES_NOW)).rejects.toMatchObject({ response: { message: "insights.range_invalid" } });
  });

  it("every sales transaction's budget covers its statements; reps declares two", async () => {
    const { svc, prisma, tx } = build();
    const perCall: number[] = [];
    prisma.$transaction.mockImplementation(async (fn: (t: SectionTx) => Promise<unknown>) => {
      const i = perCall.push(0) - 1;
      return fn({
        $executeRawUnsafe: tx.$executeRawUnsafe,
        $queryRaw: ((sql: Prisma.Sql) => {
          perCall[i] += 1;
          return tx.$queryRaw(sql);
        }) as never,
      });
    });
    await svc.sales("ws1", SALES_RANGE, undefined, SALES_NOW);
    const calls = prisma.$transaction.mock.calls as unknown as [unknown, { timeout: number }][];
    expect(calls).toHaveLength(11);
    calls.forEach((call, i) => expect({ i, ok: call[1].timeout > SECTION_STATEMENT_TIMEOUT_MS * perCall[i] }).toEqual({ i, ok: true }));
    expect(Math.max(...perCall)).toBe(2);
  });

  it("a timed-out sales section is unavailable and others answer", async () => {
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { meta: { code: "57014" } });
    const { svc } = build({ fail: { "sales.waiting": timeout, "sales.funnel": new Error("boom") } });
    const res = await svc.sales("ws1", SALES_RANGE, undefined, SALES_NOW);
    expect(res.headline).toEqual({ status: "unavailable" });
    expect(res.funnel).toEqual({ status: "unavailable" });
    expect(res.reps).toEqual({ status: "ok", data: SALES_OWNER.reps });
    expect(res.weekly).toEqual({ status: "ok", data: SALES_OWNER.weekly });
  });

  it("waiting and follow-ups use the request's one now; the range is not involved", async () => {
    const { svc, queried } = build();
    await svc.sales("ws1", SALES_RANGE, undefined, SALES_NOW);
    const waiting = queried.find((s) => tagOf(s) === "sales.waiting")!;
    expect(waiting.values).toContain(SALES_NOW.toISOString());
    expect(waiting.values).not.toContain("2026-11-07T21:00:00.000Z");
    const reps = queried.find((s) => tagOf(s) === "sales.reps")!;
    expect(reps.values).toContain(SALES_NOW.toISOString());
    expect(reps.values).toContain("2026-11-30T21:00:00.000Z"); // end of today in Riyadh
  });
});
