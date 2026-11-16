/**
 * SP-16 final review M4 (and the live verification): only a real statement
 * timeout (Postgres 57014) is cached as "too large to count right now".
 * A pool wait or an expired interactive transaction (Prisma P2028 / P2024)
 * and a row skipped by the list deadline are "not counted yet": `skipped`,
 * never cached.
 */
import { Prisma } from "@prisma/client";
import { isStatementTimeout, timeoutKind } from "./audience-count";
import type { AudienceNode, AudienceRules } from "./audience-rules";
import { createAudienceDb, type AudienceDb } from "./audience-test-db";
import { NOW, predicateWorld, seg, WS } from "./__fixtures__/audience-world";
import { SegmentsController } from "./segments.controller";
import { SegmentsService } from "./segments.service";

const tree = (...rules: AudienceNode[]): AudienceRules => ({ v: 2, op: "and", rules });
const lead: AudienceNode = { field: "lifecycle", op: "in", values: ["lead"] };

/** As Prisma 5.22 surfaced a real `SET LOCAL statement_timeout` cancel live: no code, no meta, 57014 in the message only. */
const live57014 = () =>
  new Prisma.PrismaClientUnknownRequestError(
    'Invalid `prisma.contact.count()` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "57014", message: "canceling statement due to statement timeout", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
    { clientVersion: "5.22.0" },
  );
const known = (code: string, message: string) => new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "5.22.0" });
const p2028 = () =>
  known("P2028", "Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 13000 ms.");
const p2024 = () => known("P2024", "Timed out fetching a new connection from the connection pool. (Current connection pool timeout: 10, connection limit: 5)");

/** Every count inside a transaction rejects with `make()`; the transaction itself is opened normally. */
function failCounts(fake: AudienceDb, make: () => unknown) {
  const orig = fake.prisma.__tx;
  fake.prisma.__tx = (id: number) => {
    const tx = orig(id);
    tx.contact.count = async () => {
      throw make();
    };
    tx.contact.findMany = async () => {
      throw make();
    };
    return tx;
  };
}

function setup(over: Record<string, unknown> = {}) {
  const t = predicateWorld();
  const s = t.segment.find((r) => r.id === "S")!;
  Object.assign(s, { memberCount: null, countedAt: null, ...over });
  const fake = createAudienceDb(t);
  const svc = new SegmentsService(fake.prisma as never);
  const ctrl = new SegmentsController(fake.prisma as never, svc, { emitSegmentUpserted: jest.fn(), emitSegmentDeleted: jest.fn() } as never);
  const cacheWrites = () => fake.calls.filter((c) => c.op === "$executeRaw" && /"memberCount"/.test(c.args.sql));
  // Read the row from the db each time: a rolled-back transaction restores rows as copies.
  return {
    fake,
    svc,
    ctrl,
    get row() {
      return fake.db.segment.find((r) => r.id === "S")!;
    },
    cacheWrites,
  };
}

describe("timeoutKind (M4)", () => {
  it("the live-shaped 57014 UnknownRequestError is a statement timeout", () => {
    expect(timeoutKind(live57014())).toBe("statement");
    expect(isStatementTimeout(live57014())).toBe(true);
  });

  it("57014 on the code, in meta, or in a wrapped cause is a statement timeout", () => {
    expect(timeoutKind(Object.assign(new Error("x"), { code: "57014" }))).toBe("statement");
    expect(timeoutKind(Object.assign(new Error("x"), { meta: { code: "57014" } }))).toBe("statement");
    expect(timeoutKind(new Error("wrapped", { cause: live57014() }))).toBe("statement");
  });

  it("P2028 and P2024 are transaction (pool) timeouts, not statement timeouts", () => {
    for (const e of [p2028(), p2024()]) {
      expect(timeoutKind(e)).toBe("transaction");
      expect(isStatementTimeout(e)).toBe(false);
    }
  });

  it("anything else is not a timeout", () => {
    expect(timeoutKind(new Error("relation does not exist"))).toBeNull();
    expect(timeoutKind(known("P2002", "Unique constraint failed"))).toBeNull();
    expect(timeoutKind(null)).toBeNull();
  });
});

describe("a real 57014 is cached as too large (M4)", () => {
  it("GET /segments/:id/count: the live-shaped 57014 answers timedOut and caches null", async () => {
    const w = setup();
    failCounts(w.fake, live57014);
    await expect(w.ctrl.count(WS, "S")).resolves.toEqual({ count: null, countedAt: expect.any(String), timedOut: true });
    expect(w.row).toMatchObject({ memberCount: null, countedAt: expect.any(Date) });
    expect(w.cacheWrites()).toHaveLength(1);
  });

  it("GET /segments: a full-length 57014 is cached as null with countedAt", async () => {
    const w = setup();
    failCounts(w.fake, live57014);
    const rows = await w.svc.listRows(WS, { now: NOW });
    expect(rows.find((r) => r.id === "S")).toMatchObject({ count: null, timedOut: true, countedAt: NOW.toISOString() });
    expect(rows.find((r) => r.id === "S")).not.toHaveProperty("skipped");
    expect(w.row.countedAt).toEqual(NOW);
  });
});

describe("P2028 and P2024 are not cached and return skipped (M4)", () => {
  it.each([
    ["P2028", p2028],
    ["P2024", p2024],
  ])("%s on GET /segments, /count and preview: skipped, timedOut false, nothing cached", async (_code, make) => {
    const w = setup();
    failCounts(w.fake, make);
    const rows = await w.svc.listRows(WS, { now: NOW });
    expect(rows.find((r) => r.id === "S")).toMatchObject({ count: null, countedAt: null, timedOut: false, skipped: true });
    await expect(w.ctrl.count(WS, "S")).resolves.toEqual({ count: null, countedAt: null, timedOut: false, skipped: true });
    await expect(w.ctrl.preview(WS, { rules: tree(lead) as never })).resolves.toEqual({
      count: null,
      timedOut: false,
      skipped: true,
      sample: [],
      issues: [],
    });
    expect(w.cacheWrites()).toHaveLength(0);
    expect(w.row).toMatchObject({ memberCount: null, countedAt: null });
  });

  it("a stale count is served instead of nothing when the pool is busy, and stays as it was", async () => {
    const at = new Date(NOW.getTime() - 60 * 60_000);
    const w = setup({ memberCount: 42, countedAt: at });
    failCounts(w.fake, p2028);
    const row = (await w.svc.listRows(WS, { now: NOW })).find((r) => r.id === "S");
    expect(row).toMatchObject({ count: 42, timedOut: false });
    expect(row).not.toHaveProperty("skipped");
    expect(w.row).toMatchObject({ memberCount: 42, countedAt: at });
    expect(w.cacheWrites()).toHaveLength(0);
  });

  it("a member page that cannot get a connection answers like a timed-out page (nothing to show), not a 500", async () => {
    const w = setup();
    failCounts(w.fake, p2024);
    await expect(w.ctrl.contacts(WS, "S")).resolves.toEqual({ items: [], nextCursor: null, timedOut: true });
  });

  it("any other error is still rethrown", async () => {
    const w = setup();
    failCounts(w.fake, () => known("P2002", "Unique constraint failed"));
    await expect(w.ctrl.count(WS, "S")).rejects.toThrow("Unique constraint failed");
  });
});

describe("rows skipped by the list deadline return skipped with no cache (M4)", () => {
  it("past the deadline: skipped, timedOut false, not counted and not cached; counted rows are cached", async () => {
    const t = predicateWorld();
    for (let i = 0; i < 8; i++) t.segment.push(seg(`late${i}`, WS, "crm", { rules: tree(lead) }));
    const fake = createAudienceDb(t);
    let counts = 0;
    const orig = fake.prisma.__tx;
    fake.prisma.__tx = (id: number) => {
      const tx = orig(id);
      const count = tx.contact.count;
      tx.contact.count = async (args: unknown) => {
        counts++;
        await new Promise((r) => setTimeout(r, 150));
        return count(args);
      };
      return tx;
    };
    const prev = process.env.AUDIENCE_LIST_DEADLINE_MS;
    process.env.AUDIENCE_LIST_DEADLINE_MS = "100";
    let rows: Awaited<ReturnType<SegmentsService["listRows"]>> = [];
    try {
      rows = await new SegmentsService(fake.prisma as never).listRows(WS, { now: NOW });
    } finally {
      if (prev === undefined) delete process.env.AUDIENCE_LIST_DEADLINE_MS;
      else process.env.AUDIENCE_LIST_DEADLINE_MS = prev;
    }
    const crm = rows.filter((x) => x.origin === "crm");
    const skipped = crm.filter((r) => r.count === null);
    expect(counts).toBeGreaterThan(0);
    expect(skipped.length).toBe(crm.length - counts);
    expect(skipped.length).toBeGreaterThan(0);
    for (const r of skipped) expect(r).toMatchObject({ count: null, countedAt: null, timedOut: false, skipped: true });
    for (const r of skipped) expect(fake.db.segment.find((x) => x.id === r.id)!.countedAt).toBeNull();
    // Only the rows actually counted were written to the cache.
    expect(fake.calls.filter((c) => c.op === "$executeRaw")).toHaveLength(counts);
  });
});
