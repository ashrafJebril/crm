import type { Prisma } from "@prisma/client";
import { CH, U } from "./__fixtures__/insights-world";
import { ATTRIBUTION_SINCE, OWNER } from "./insights-expected";
import { FORMER_KEY, UNATTRIBUTED_KEY } from "./insights-format";
import { createLimiter, InsightsService, runSection, SectionQueueTimeout, sectionLimiter, type Limiter, type LimitOptions, type SectionTx } from "./insights.service";
import { INSIGHTS_HOME_MIGRATION, SECTION_QUEUE_TIMEOUT_MS } from "./insights-constants";
import { MAX_CONCURRENT_SECTIONS, maxConcurrentSections, SECTION_STATEMENT_TIMEOUT_MS, sectionTransactionTimeoutMs } from "./insights-constants";

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
  attributionSince: [{ since: ATTRIBUTION_SINCE.world }],
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
    expect(res.attributionSince).toBe(ATTRIBUTION_SINCE.world);
  });

  it("attribution date: null when no reply has a sender or when its lookup fails", async () => {
    const none = build({ rows: { ...OWNER_ROWS, attributionSince: [{ since: null }] } });
    expect((await none.svc.support("ws1", Q, { userId: U.owner }, NOW)).attributionSince).toBeNull();
    const failed = build({ fail: { attributionSince: new Error("boom") } });
    const res = await failed.svc.support("ws1", Q, { userId: U.owner }, NOW);
    expect(res.attributionSince).toBeNull();
    expect(res.team).toEqual({ status: "ok", data: OWNER.team });
    // One aggregate in its own one-statement transaction, bound to the workspace.
    const sql = failed.queried.find((q) => tagOf(q) === "attributionSince")!;
    const text = sql.strings.join("?");
    expect(text).toContain(`"_prisma_migrations"`);
    expect(text).not.toContain(`"Message"`);
    expect(sql.values).toEqual(expect.arrayContaining(["ws1", INSIGHTS_HOME_MIGRATION, "Asia/Riyadh"]));
  });

  it("every section runs in its own transaction with statement_timeout and jit off", async () => {
    const { svc, prisma, executed } = build();
    await svc.support("ws1", Q, { userId: U.owner }, NOW);
    // Six headline statements, four sections, Team, the attribution date.
    expect(prisma.$transaction).toHaveBeenCalledTimes(12);
    expect(executed.filter((q) => q === "SET LOCAL statement_timeout = '8s'")).toHaveLength(12);
    expect(executed.filter((q) => q === "SET LOCAL jit = off")).toHaveLength(12);
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
    expect(calls).toHaveLength(12);
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
    expect(started).toBe(24);
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
    expect(prisma.$transaction).toHaveBeenCalledTimes(12);
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
    for (const sql of ok.queried.filter((s) => !["teamMembers", "attributionSince"].includes(tagOf(s)))) {
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

describe("section limiter: lanes, fairness and the configurable limit", () => {
  /** A task that records its start and waits for its own release. */
  function gate() {
    const order: string[] = [];
    const releases = new Map<string, () => void>();
    const task = (name: string) => () =>
      new Promise<string>((resolve) => {
        order.push(name);
        releases.set(name, () => resolve(name));
      });
    const release = async (name: string) => {
      releases.get(name)!();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { order, task, release };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("home is served before queued analytics work", async () => {
    const limit = createLimiter(1);
    const g = gate();
    const running = limit(g.task("report-1"), { key: "wsA" });
    const queued = [
      limit(g.task("report-2"), { key: "wsA" }),
      limit(g.task("report-3"), { key: "wsA" }),
      // The home's re-check (home.openable) arrives last but goes first.
      limit(g.task("home-openable"), { key: "wsA", lane: "home" }),
    ];
    await tick();
    await g.release("report-1");
    expect(g.order).toEqual(["report-1", "home-openable"]);
    await g.release("home-openable");
    await g.release("report-2");
    await g.release("report-3");
    await Promise.all([running, ...queued]);
    // FIFO within the report lane.
    expect(g.order).toEqual(["report-1", "home-openable", "report-2", "report-3"]);
  });

  it("one workspace never holds both slots while another workspace waits", async () => {
    const limit = createLimiter(2);
    const g = gate();
    const all = [
      limit(g.task("A-team-1"), { key: "wsA" }),
      limit(g.task("A-team-2"), { key: "wsA" }),
      limit(g.task("A-team-3"), { key: "wsA" }),
      limit(g.task("B-home"), { key: "wsB", lane: "home" }),
    ];
    await tick();
    // Nobody else waited when A took both slots.
    expect(g.order).toEqual(["A-team-1", "A-team-2"]);
    await g.release("A-team-1");
    // B (nothing in flight) goes before A's third section.
    expect(g.order).toEqual(["A-team-1", "A-team-2", "B-home"]);
    await g.release("A-team-2");
    expect(g.order).toEqual(["A-team-1", "A-team-2", "B-home", "A-team-3"]);
    await g.release("B-home");
    await g.release("A-team-3");
    await Promise.all(all);
  });

  it("fairness beats the lane: a busy workspace's home waits behind another workspace's report", async () => {
    const limit = createLimiter(2);
    const g = gate();
    const all = [
      limit(g.task("A-1"), { key: "wsA" }),
      limit(g.task("B-1"), { key: "wsB" }),
      limit(g.task("A-home"), { key: "wsA", lane: "home" }),
      limit(g.task("C-report"), { key: "wsC" }),
    ];
    await tick();
    await g.release("B-1");
    expect(g.order).toEqual(["A-1", "B-1", "C-report"]);
    await g.release("A-1");
    expect(g.order).toEqual(["A-1", "B-1", "C-report", "A-home"]);
    await g.release("C-report");
    await g.release("A-home");
    await Promise.all(all);
  });

  it("deadline and abort still apply in every lane", async () => {
    const limit = createLimiter(1, { queueTimeoutMs: 20 });
    const g = gate();
    const running = limit(g.task("hold"), { key: "wsA" });
    await expect(limit(g.task("home"), { key: "wsB", lane: "home" })).rejects.toBeInstanceOf(SectionQueueTimeout);
    const ac = new AbortController();
    const aborted = limit(g.task("home2"), { key: "wsB", lane: "home", signal: ac.signal });
    ac.abort();
    await expect(aborted).rejects.toThrow("request aborted before the section started");
    await g.release("hold");
    await running;
    expect(g.order).toEqual(["hold"]);
  });

  it("the limit reads INSIGHTS_MAX_CONCURRENT_SECTIONS, default 2, clamped to 1–4", () => {
    expect(maxConcurrentSections({})).toBe(2);
    expect(maxConcurrentSections({ INSIGHTS_MAX_CONCURRENT_SECTIONS: "" })).toBe(2);
    expect(maxConcurrentSections({ INSIGHTS_MAX_CONCURRENT_SECTIONS: "abc" })).toBe(2);
    expect(maxConcurrentSections({ INSIGHTS_MAX_CONCURRENT_SECTIONS: "3" })).toBe(3);
    expect(maxConcurrentSections({ INSIGHTS_MAX_CONCURRENT_SECTIONS: " 4 " })).toBe(4);
    expect(maxConcurrentSections({ INSIGHTS_MAX_CONCURRENT_SECTIONS: "0" })).toBe(1);
    expect(maxConcurrentSections({ INSIGHTS_MAX_CONCURRENT_SECTIONS: "-5" })).toBe(1);
    expect(maxConcurrentSections({ INSIGHTS_MAX_CONCURRENT_SECTIONS: "12" })).toBe(4);
    expect(maxConcurrentSections({ INSIGHTS_MAX_CONCURRENT_SECTIONS: "2.9" })).toBe(2);
  });

  it("runSection queues with its lane and workspace", async () => {
    const seen: LimitOptions[] = [];
    const spy: Limiter = (task, o) => {
      seen.push(o ?? {});
      return task();
    };
    const db = { $transaction: async (fn: (t: SectionTx) => Promise<unknown>) => fn({ $executeRawUnsafe: async () => 0, $queryRaw: (async () => []) as never }) };
    expect(await runSection(db as never, "x", async () => 1, undefined, { limiter: spy, lane: "home", workspaceId: "ws9" })).toEqual({ status: "ok", data: 1 });
    expect(await runSection(db as never, "y", async () => 2, undefined, { limiter: spy, workspaceId: "ws9" })).toEqual({ status: "ok", data: 2 });
    expect(seen[0]).toMatchObject({ lane: "home", key: "ws9" });
    // Analytics: the report lane is the limiter's default.
    expect(seen[1]).toMatchObject({ key: "ws9" });
    expect(seen[1].lane ?? "report").toBe("report");
  });
});
