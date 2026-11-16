import type { Prisma } from "@prisma/client";
import { CH, U } from "./__fixtures__/insights-world";
import { OWNER } from "./insights-expected";
import { FORMER_KEY, UNATTRIBUTED_KEY } from "./insights-format";
import { createLimiter, InsightsService, runSection, SectionQueueTimeout, sectionLimiter, type SectionTx } from "./insights.service";
import { SECTION_QUEUE_TIMEOUT_MS } from "./insights-constants";
import { MAX_CONCURRENT_SECTIONS, SECTION_STATEMENT_TIMEOUT_MS, sectionTransactionTimeoutMs } from "./insights-constants";

/** The `/* insights:support.<name> *\/` tag a statement starts with. */
const tagOf = (sql: Prisma.Sql) => /insights:support\.(\w+)/.exec(sql.strings[0])?.[1] ?? "?";

/** Rows the real SQL returns for the owner over the fixture world (the
 *  DB spec proves the SQL; this proves the shaping). */
const OWNER_ROWS: Record<string, unknown[]> = {
  conversations: [{ conversations: 8 }],
  aiResolution: [{ decided: 7, aiResolved: 3 }],
  firstResponse: [{ median: 450, unanswered: 1 }],
  handling: [{ median: 20100 }],
  timeSaved: [{ customerMessages: 4 }],
  ticketShare: [{ conversations: 8, ticketed: 2 }],
  resolutionMix: [
    { bucket: "ai", n: 3 },
    { bucket: "human", n: 1 },
    { bucket: "escalated", n: 2 },
    { bucket: "closed", n: 1 },
  ],
  peaks: [
    { dow: 0, hour: 0, n: 1 },
    { dow: 1, hour: 8, n: 1 },
    { dow: 1, hour: 9, n: 1 },
    { dow: 1, hour: 13, n: 1 },
    { dow: 2, hour: 11, n: 1 },
    { dow: 3, hour: 23, n: 1 },
    { dow: 5, hour: 0, n: 1 },
    { dow: 5, hour: 12, n: 1 },
    { dow: 6, hour: 23, n: 1 },
  ],
  // Unordered, as SQL may return them.
  byNumber: [
    { channelId: null, label: null, exists: false, conversations: 1, decided: 0, ai: 0 },
    { channelId: CH.b, label: "Jeddah line", exists: true, conversations: 2, decided: 1, ai: 0 },
    { channelId: CH.a, label: "Riyadh line", exists: true, conversations: 4, decided: 5, ai: 3 },
  ],
  topicFriction: [
    { topic: "refund", count: 4, escalated: 2, negative: 3 },
    { topic: "delivery", count: 6, escalated: 2, negative: 2 },
  ],
  teamMembers: [
    { userId: U.owner, name: "Omar" },
    { userId: U.admin, name: "Amal" },
    { userId: U.agent, name: "Badr" },
    { userId: U.viewer, name: "Huda" },
    { userId: U.assigned, name: "Sami" },
  ],
  team: [
    { key: U.agent, assigned: 3, replies: 1, resolved: 1, median: 720 },
    { key: U.assigned, assigned: 2, replies: 2, resolved: 0, median: 180 },
    { key: U.owner, assigned: 1, replies: 0, resolved: 0, median: null },
    { key: FORMER_KEY, assigned: 1, replies: 1, resolved: 0, median: 1200 },
    { key: UNATTRIBUTED_KEY, assigned: 0, replies: 1, resolved: 0, median: 120 },
  ],
};

function build(opts: { rows?: Record<string, unknown[]>; fail?: Record<string, unknown>; channels?: any[] } = {}) {
  const rows = opts.rows ?? OWNER_ROWS;
  const executed: string[] = [];
  const queried: Prisma.Sql[] = [];
  const tx: SectionTx = {
    $executeRawUnsafe: jest.fn(async (q: string) => {
      executed.push(q);
      return 0;
    }),
    $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
      queried.push(sql);
      const tag = tagOf(sql);
      if (opts.fail && tag in opts.fail) throw opts.fail[tag];
      return (rows[tag] ?? []) as never;
    }) as never,
  };
  const channels = opts.channels ?? [
    { id: CH.a, workspaceId: "ws1", kind: "whatsapp" },
    { id: CH.ig, workspaceId: "ws1", kind: "instagram" },
    { id: "ch-foreign", workspaceId: "ws2", kind: "whatsapp" },
  ];
  const prisma = {
    workspace: { findUnique: jest.fn(async () => ({ timezone: "Asia/Riyadh", lang: "ar" })) },
    channel: {
      findFirst: jest.fn(async ({ where }: any) => {
        const c = channels.find((x) => x.id === where.id && x.workspaceId === where.workspaceId);
        return c ? { id: c.id, kind: c.kind } : null;
      }),
    },
    $transaction: jest.fn(async (fn: (t: SectionTx) => Promise<unknown>) => fn(tx)),
  };
  const perm = { conversationScope: jest.fn(async () => ({})) };
  const svc = new InsightsService(prisma as never, perm as never);
  return { svc, prisma, perm, tx, executed, queried };
}

const NOW = new Date("2026-11-10T09:00:00Z");
const Q = { from: "2026-11-01", to: "2026-11-07" };

describe("InsightsService.support", () => {
  it("shapes the SQL rows into the support DTO (owner expectations)", async () => {
    const { svc } = build();
    const res = await svc.support("ws1", Q, { userId: U.owner }, NOW);
    expect(res.range).toEqual({ from: "2026-11-01", to: "2026-11-07", tz: "Asia/Riyadh" });
    expect(res.channelId).toBeNull();
    expect(res.headline).toEqual({ status: "ok", data: OWNER.headline });
    expect(res.resolutionMix).toEqual({ status: "ok", data: OWNER.resolutionMix });
    expect(res.peaks).toEqual({ status: "ok", data: OWNER.peaks });
    expect(res.byNumber).toEqual({ status: "ok", data: OWNER.byNumber });
    expect(res.topicFriction).toEqual({ status: "ok", data: OWNER.topicFriction });
    expect(res.team).toEqual({ status: "ok", data: OWNER.team });
  });

  it("every section runs in its own transaction with statement_timeout and jit off", async () => {
    const { svc, prisma, executed } = build();
    await svc.support("ws1", Q, { userId: U.owner }, NOW);
    // Six headline statements, four sections, Team.
    expect(prisma.$transaction).toHaveBeenCalledTimes(11);
    expect(executed.filter((q) => q === "SET LOCAL statement_timeout = '8s'")).toHaveLength(11);
    expect(executed.filter((q) => q === "SET LOCAL jit = off")).toHaveLength(11);
  });

  it("each transaction's budget covers statement_timeout for every statement it runs", async () => {
    const { svc, prisma, tx } = build();
    const perCall: number[] = [];
    // Count each transaction's statements on its own tx (sections overlap).
    prisma.$transaction.mockImplementation(async (fn: (t: SectionTx) => Promise<unknown>) => {
      const i = perCall.push(0) - 1;
      const own: SectionTx = {
        $executeRawUnsafe: tx.$executeRawUnsafe,
        $queryRaw: ((sql: Prisma.Sql) => {
          perCall[i] += 1;
          return tx.$queryRaw(sql);
        }) as never,
      };
      return fn(own);
    });
    await svc.support("ws1", Q, { userId: U.owner }, NOW);
    const calls = prisma.$transaction.mock.calls as unknown as [unknown, { timeout: number; maxWait: number }][];
    expect(calls).toHaveLength(11);
    calls.forEach((call, i) => {
      expect({ i, ok: call[1].timeout > SECTION_STATEMENT_TIMEOUT_MS * perCall[i] }).toEqual({ i, ok: true });
    });
    // The headline is split: no transaction runs more than Team's two statements.
    expect(Math.max(...perCall)).toBe(2);
    expect(sectionTransactionTimeoutMs(1)).toBeGreaterThan(SECTION_STATEMENT_TIMEOUT_MS);
    expect(sectionTransactionTimeoutMs(6)).toBeGreaterThan(6 * SECTION_STATEMENT_TIMEOUT_MS);
  });

  it("no more than MAX_CONCURRENT_SECTIONS (2) sections hold a connection at once", async () => {
    expect(MAX_CONCURRENT_SECTIONS).toBe(2);
    const { svc, prisma, tx } = build();
    let inFlight = 0;
    let peak = 0;
    let started = 0;
    prisma.$transaction.mockImplementation(async (fn: (t: SectionTx) => Promise<unknown>) => {
      inFlight += 1;
      started += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return await fn(tx);
      } finally {
        inFlight -= 1;
      }
    });
    // Two concurrent report loads share the process-wide limit.
    const [a, b] = await Promise.all([
      svc.support("ws1", Q, { userId: U.owner }, NOW),
      svc.support("ws1", Q, { userId: U.owner }, NOW),
    ]);
    expect(started).toBe(22);
    expect(peak).toBe(2);
    expect(a.headline).toEqual({ status: "ok", data: OWNER.headline });
    expect(b.team).toEqual({ status: "ok", data: OWNER.team });
  });

  it("a section queued past the deadline is unavailable and never opens a transaction", async () => {
    expect(SECTION_QUEUE_TIMEOUT_MS).toBe(10_000);
    const limiter = createLimiter(1, { queueTimeoutMs: 30 });
    let release!: () => void;
    const busy = limiter(() => new Promise<void>((r) => (release = r)));
    const db = { $transaction: jest.fn(async (fn: (t: SectionTx) => Promise<unknown>) => fn({ $executeRawUnsafe: async () => 0, $queryRaw: async () => [] as never })) };
    const warn = jest.fn();
    const res = await runSection(db as never, "late", async () => 1, { warn }, { limiter });
    expect(res).toEqual({ status: "unavailable" });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("waited 30 ms");
    // The slot frees up: the next section runs normally.
    release();
    await busy;
    expect(await runSection(db as never, "next", async () => 2, { warn }, { limiter })).toEqual({ status: "ok", data: 2 });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("a section whose request was aborted while queued never runs", async () => {
    const limiter = createLimiter(1, { queueTimeoutMs: 5_000 });
    let release!: () => void;
    const busy = limiter(() => new Promise<void>((r) => (release = r)));
    const db = { $transaction: jest.fn() };
    const ac = new AbortController();
    const pending = runSection(db as never, "aborted", async () => 1, undefined, { limiter, signal: ac.signal });
    ac.abort();
    expect(await pending).toEqual({ status: "unavailable" });
    // Already aborted before queueing: rejected at once.
    expect(await runSection(db as never, "aborted2", async () => 1, undefined, { limiter, signal: ac.signal })).toEqual({ status: "unavailable" });
    release();
    await busy;
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("without contention every section runs as before, under the process-wide deadline", async () => {
    await expect(sectionLimiter(async () => "ran")).resolves.toBe("ran");
    const { svc, prisma } = build();
    const res = await svc.support("ws1", Q, { userId: U.owner }, NOW, new AbortController().signal);
    expect(prisma.$transaction).toHaveBeenCalledTimes(11);
    expect(res.headline).toEqual({ status: "ok", data: OWNER.headline });
    expect(new SectionQueueTimeout(5).message).toBe("waited 5 ms for a section slot");
  });

  it("the limiter runs tasks FIFO, never above its limit, and keeps going after a failure", async () => {
    const limit = createLimiter(2);
    let inFlight = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (n: number, fail = false) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      order.push(n);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      if (fail) throw new Error(`t${n}`);
      return n;
    };
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => limit(task(n, n === 2))));
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
  });

  it("one slow headline statement makes the headline unavailable, not the other sections", async () => {
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { meta: { code: "57014" } });
    const { svc } = build({ fail: { handling: timeout } });
    const res = await svc.support("ws1", Q, { userId: U.owner }, NOW);
    expect(res.headline).toEqual({ status: "unavailable" });
    expect(res.team).toEqual({ status: "ok", data: OWNER.team });
    expect(res.resolutionMix).toEqual({ status: "ok", data: OWNER.resolutionMix });
  });

  it("a timed-out section is unavailable and others answer", async () => {
    const timeout = Object.assign(new Error('PostgresError { code: "57014", message: "canceling statement due to statement timeout" }'), {
      code: "P2010",
      meta: { code: "57014" },
    });
    const { svc } = build({ fail: { peaks: timeout, topicFriction: new Error("boom") } });
    const res = await svc.support("ws1", Q, { userId: U.owner }, NOW);
    expect(res.peaks).toEqual({ status: "unavailable" });
    expect(res.topicFriction).toEqual({ status: "unavailable" });
    expect(res.headline).toEqual({ status: "ok", data: OWNER.headline });
    expect(res.team.status).toBe("ok");
    expect(res.byNumber.status).toBe("ok");
    expect(res.resolutionMix.status).toBe("ok");
  });

  it("runSection reports unavailable when the transaction itself fails", async () => {
    const db = { $transaction: jest.fn(async () => Promise.reject(Object.assign(new Error("x"), { code: "57014" }))) };
    const warn = jest.fn();
    expect(await runSection(db as never, "t", async () => 1, { warn })).toEqual({ status: "unavailable" });
    expect(warn.mock.calls[0][0]).toContain("statement timeout");
  });

  it("foreign channel id is 404", async () => {
    const { svc } = build();
    const err = (p: Promise<unknown>) => p.then(() => null, (e) => ({ status: e.getStatus(), body: e.getResponse() }));
    const notFound = { status: 404, body: { statusCode: 404, message: "insights.channel_not_found" } };
    // Workspace B's number asked from A; an Instagram account; an unknown id; a repeated param.
    expect(await err(svc.support("ws1", { ...Q, channelId: "ch-foreign" }, undefined, NOW))).toEqual(notFound);
    expect(await err(svc.support("ws1", { ...Q, channelId: CH.ig }, undefined, NOW))).toEqual(notFound);
    expect(await err(svc.support("ws1", { ...Q, channelId: "nope" }, undefined, NOW))).toEqual(notFound);
    expect(await err(svc.support("ws1", { ...Q, channelId: [CH.a, CH.a] }, undefined, NOW))).toEqual(notFound);
    // Own WhatsApp number: every statement is narrowed to it.
    const ok = build();
    const res = await ok.svc.support("ws1", { ...Q, channelId: CH.a }, undefined, NOW);
    expect(res.channelId).toBe(CH.a);
    for (const sql of ok.queried.filter((s) => tagOf(s) !== "teamMembers")) {
      expect({ tag: tagOf(sql), narrowed: sql.strings.join("?").includes('c."channelId" = ?') && sql.values.includes(CH.a) }).toEqual({
        tag: tagOf(sql),
        narrowed: true,
      });
    }
  });

  it("a bad range is 400 before any query", async () => {
    const { svc, prisma } = build();
    await expect(svc.support("ws1", { from: "2026-11-08", to: "2026-11-01" }, undefined, NOW)).rejects.toMatchObject({
      response: { message: "insights.range_invalid" },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rates and medians are null on empty input (shaping)", async () => {
    const { svc } = build({ rows: {} });
    const res = await svc.support("ws1", Q, undefined, NOW);
    expect(res.headline).toEqual({
      status: "ok",
      data: {
        conversations: 0,
        decided: 0,
        aiResolved: 0,
        aiResolutionRate: null,
        medianFirstResponseSec: null,
        unanswered: 0,
        medianHandlingSec: null,
        timeSaved: { customerMessages: 0, hours: 0 },
        ticketShare: null,
      },
    });
    expect(res.resolutionMix).toEqual({ status: "ok", data: { ai: 0, human: 0, escalated: 0, closed: 0 } });
    expect(res.byNumber).toEqual({ status: "ok", data: [] });
    expect(res.topicFriction).toEqual({ status: "ok", data: [] });
    expect(res.team).toEqual({ status: "ok", data: [] });
    if (res.peaks.status !== "ok") throw new Error("peaks");
    expect(res.peaks.data.matrix.flat().every((n) => n === 0)).toBe(true);
  });
});
