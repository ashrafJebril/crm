import { NotFoundException } from "@nestjs/common";
import { audienceErrorBody } from "./audience-errors";
import { LEGACY_SENTINEL_JSON, type AudienceNode, type AudienceRules } from "./audience-rules";
import { createAudienceDb, evaluateContacts, type AudienceDb } from "./audience-test-db";
import { legacyBuildWhere, legacyParseFilter } from "./__fixtures__/legacy-build-where";
import { contact, NOW, predicateWorld, seg, WS, WS_B } from "./__fixtures__/audience-world";
import { SegmentsController } from "./segments.controller";
import { SegmentsService } from "./segments.service";

const tree = (...rules: AudienceNode[]): AudienceRules => ({ v: 2, op: "and", rules });
const lead: AudienceNode = { field: "lifecycle", op: "in", values: ["lead"] };
const outbound = () => ({ emitSegmentUpserted: jest.fn(async () => true), emitSegmentDeleted: jest.fn(async () => true) });

async function bodyOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return audienceErrorBody(e);
  }
  throw new Error("expected a rejection");
}

function setup(fake: AudienceDb = createAudienceDb(predicateWorld())) {
  const svc = new SegmentsService(fake.prisma as never);
  const ctrl = new SegmentsController(fake.prisma as never, svc, outbound() as never);
  return { fake, svc, ctrl, t: fake.db };
}

/** Make every transaction's contact.count reject like Postgres 57014, logging the statement order. */
function timeoutCounts(fake: AudienceDb) {
  const events: string[] = [];
  const orig = fake.prisma.__tx;
  fake.prisma.__tx = (id: number) => {
    const tx = orig(id);
    const unsafe = tx.$executeRawUnsafe;
    tx.$executeRawUnsafe = async (sql: string) => {
      events.push(`${id}:${sql}`);
      return unsafe(sql);
    };
    tx.contact.count = async () => {
      events.push(`${id}:count`);
      throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    };
    return tx;
  };
  return events;
}

describe("pre-SP-16 reader sees nobody for a v2 audience", () => {
  it("a tree with last_active stores the sentinel; the frozen legacy buildWhere over it matches 0", async () => {
    const { svc, t } = setup();
    // Every contact has a ticket, so a stage-key match would find someone if the sentinel were a real key.
    for (const c of t.contact) t.ticket.push({ id: `k-${c.id}`, contactId: c.id, workspaceId: c.workspaceId, pipelineId: "P1", stageId: "s1new", closedAt: null });
    const row = await svc.save(WS, { name: "Active", rules: tree({ field: "last_active", op: "within", value: { amount: 7, unit: "days" } }) }, { now: NOW });
    const stored = t.segment.find((s) => s.id === row.id)!;
    expect(stored.filter).toBe(LEGACY_SENTINEL_JSON);
    expect(row.filter).toEqual({ stageAny: ["__sp16_rules_v2__"] });
    expect(evaluateContacts(t, legacyBuildWhere(WS, legacyParseFilter(stored.filter)))).toEqual([]);
    expect(evaluateContacts(t, await svc.resolveContactWhere(WS, row.id, { now: NOW }))).toEqual(["a1", "a5"]);
  });

  it("a legacy-expressible tree stores its projection and both readers agree", async () => {
    const { svc, t } = setup();
    const row = await svc.save(WS, { name: "Leads with VIP", rules: tree(lead, { op: "or", rules: [{ field: "tag", op: "has", tag: "VIP" }] }) });
    const stored = t.segment.find((s) => s.id === row.id)!;
    expect(JSON.parse(stored.filter)).toEqual({ lifecycle: ["lead"], tagsAny: ["VIP"] });
    expect(row.rulesSource).toBe("rules");
    const legacy = evaluateContacts(t, legacyBuildWhere(WS, legacyParseFilter(stored.filter)));
    expect(legacy).toEqual(["a1"]);
    expect(evaluateContacts(t, await svc.resolveContactWhere(WS, row.id))).toEqual(legacy);
  });

  it("an older client's legacy filter PATCH on a v2 row never widens it: rules win, filter stays the sentinel", async () => {
    const { svc, t } = setup();
    const row = await svc.save(WS, { name: "X", rules: tree({ field: "conversations", op: "none" }) });
    // An old form that cannot show the tree sends {} (the whole workspace) with a rename.
    const updated = await svc.save(WS, { name: "Renamed", filter: {} }, { id: row.id });
    const stored = t.segment.find((s) => s.id === row.id)!;
    expect(stored.rules).toEqual(tree({ field: "conversations", op: "none" }));
    expect(stored.filter).toBe(LEGACY_SENTINEL_JSON);
    expect(updated).toMatchObject({ name: "Renamed", rulesSource: "rules" });
    expect(evaluateContacts(t, legacyBuildWhere(WS, legacyParseFilter(stored.filter)))).toEqual([]);
    expect(evaluateContacts(t, await svc.resolveContactWhere(WS, row.id))).toEqual(["a3"]);
    // A legacy row still takes a legacy filter, as before.
    const legacy = await svc.save(WS, { name: "L", filter: { lifecycle: ["lead"] } });
    await svc.save(WS, { filter: { lifecycle: ["customer"] } }, { id: legacy.id });
    expect(evaluateContacts(t, await svc.resolveContactWhere(WS, legacy.id))).toEqual(["a2", "a5"]);
  });
});

describe("rules over the limits are rejected (save and preview)", () => {
  const leaves = (n: number, tag = "t"): AudienceNode[] => Array.from({ length: n }, (_, i) => ({ field: "tag", op: "has", tag: `${tag}${i}` }));

  it("expansion through referenced audiences over 100 → rules_too_large {max: 100}", async () => {
    const { svc, t } = setup();
    t.segment.push(
      seg("X1", WS, "crm", { rules: tree(...leaves(30, "a")) }),
      seg("X2", WS, "crm", { rules: tree(...leaves(30, "b")) }),
      seg("X3", WS, "crm", { rules: tree(...leaves(30, "c")) }),
    );
    const refs: AudienceNode[] = ["X1", "X2", "X3"].map((id) => ({ field: "group", op: "in", segmentId: id }));
    const exactly100 = tree(...refs, ...leaves(10));
    await expect(svc.preview(WS, { rules: exactly100 })).resolves.toMatchObject({ issues: [] });
    const over = tree(...refs, ...leaves(11));
    expect(await bodyOf(svc.save(WS, { name: "Big", rules: over }))).toMatchObject({ message: "audiences.rules_too_large", max: 100 });
    expect(await bodyOf(svc.preview(WS, { rules: over }))).toMatchObject({ message: "audiences.rules_too_large", max: 100 });
  });

  it("filter and rules together → invalid_rules {path: [], reason: filter_and_rules}", async () => {
    const { svc } = setup();
    const both = { filter: { lifecycle: ["lead"] }, rules: tree(lead) };
    for (const p of [svc.save(WS, { name: "X", ...both }), svc.save(WS, both, { id: "S" }), svc.preview(WS, both)]) {
      expect(await bodyOf(p)).toMatchObject({ statusCode: 400, message: "audiences.invalid_rules", path: [], reason: "filter_and_rules" });
    }
  });

  it("an invalid tree is a 400 on save and preview; rules on a manual group → not_smart", async () => {
    const { svc } = setup();
    const bad = { v: 2, op: "and", rules: [{ field: "created", op: "before", date: "2026-13-01" }] };
    expect(await bodyOf(svc.save(WS, { name: "X", rules: bad }))).toMatchObject({ message: "audiences.invalid_rules", path: [0], reason: "bad_date" });
    expect(await bodyOf(svc.preview(WS, { rules: bad }))).toMatchObject({ message: "audiences.invalid_rules" });
    expect(await bodyOf(svc.save(WS, { rules: tree(lead) }, { id: "G" }))).toMatchObject({ statusCode: 400, message: "audiences.not_smart" });
    expect(await bodyOf(svc.save(WS, { name: "M", origin: "manual", rules: tree(lead) }))).toMatchObject({ message: "audiences.not_smart" });
  });

  it("a custom-field value the def rejects is SP-02's 400", async () => {
    const { svc } = setup();
    await expect(svc.save(WS, { name: "X", rules: tree({ field: "custom_field", op: "contains", defId: "dN", value: "1" }) })).rejects.toMatchObject({ status: 400 });
    await expect(svc.preview(WS, { rules: tree({ field: "custom_field", op: "gt", defId: "dN", value: "abc" }) })).rejects.toMatchObject({ status: 400 });
  });
});

describe("foreign ids inside rules are not found", () => {
  const CASES: Array<[string, AudienceNode, string, string]> = [
    ["group", { field: "group", op: "in", segmentId: "GB" }, "segmentId", "GB"],
    ["pipeline", { field: "pipeline_stage", op: "in", pipelineId: "PB" }, "pipelineId", "PB"],
    ["stage", { field: "pipeline_stage", op: "in", pipelineId: "P1", stageId: "sBnew" }, "stageId", "sBnew"],
    ["field", { field: "custom_field", op: "set", defId: "dBforeign" }, "defId", "dBforeign"],
    ["campaign", { field: "campaign", op: "replied", campaignId: "CB" }, "campaignId", "CB"],
  ];

  it.each(CASES)("a workspace-B %s id → 404 reference_not_found on create, update and preview", async (_n, rule, field, id) => {
    const { svc, t, fake } = setup();
    t.segment.push(seg("E", WS, "crm", { rules: tree(lead) }));
    for (const p of [
      svc.save(WS, { name: "X", rules: tree(lead, rule) }),
      svc.save(WS, { rules: tree(rule) }, { id: "E" }),
      svc.preview(WS, { rules: tree({ op: "or", rules: [lead, rule] }) }),
    ]) {
      expect(await bodyOf(p)).toEqual({ statusCode: 404, message: "audiences.reference_not_found", field, id });
    }
    expect(fake.calls.filter((c) => c.op === "create" || c.op === "update")).toEqual([]);
    expect(t.segment.find((s) => s.id === "E")!.rules).toEqual(tree(lead));
  });
});

describe("audience pages are keyset and bounded at 100k", () => {
  const N = 100_000;
  const id = (i: number) => `c${String(i).padStart(6, "0")}`;
  const t = predicateWorld();
  t.contact = [];
  for (let i = 0; i < N; i++) {
    t.contact.push(contact(id(i), WS, { name: `Contact ${i}`, tags: i % 7 === 0 ? '["T7"]' : "[]" }));
  }
  t.segment.push(seg("SM", WS, "crm", { rules: tree({ field: "tag", op: "has", tag: "T7" }) }), seg("MG", WS, "manual"));
  for (let i = 0; i < N; i += 997) t.segmentMember.push({ segmentId: "MG", contactId: id(i) });

  async function walk(fake: AudienceDb, page: (after?: string) => Promise<{ items: { id: string }[]; nextCursor: string | null }>) {
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const p = await page(after);
      pages++;
      expect(p.items.length).toBeLessThanOrEqual(100);
      seen.push(...p.items.map((x) => x.id));
      if (!p.nextCursor) break;
      after = p.nextCursor;
    }
    const finds = fake.calls.filter((c) => c.model === "contact" && c.op === "findMany");
    expect(finds).toHaveLength(pages);
    finds.forEach((c, i) => {
      expect(c.args.take).toBeLessThanOrEqual(101);
      expect(c.args.orderBy).toEqual({ id: "asc" });
      expect(c.args.skip).toBeUndefined();
      expect(c.args.where.workspaceId).toBe(WS);
      if (i > 0) expect(c.args.where.AND).toContainEqual({ id: { gt: expect.any(String) } });
    });
    return seen;
  }

  it("pageContacts walks a smart audience matching every 7th contact with no duplicate and no gap", async () => {
    const fake = createAudienceDb(t);
    const svc = new SegmentsService(fake.prisma as never);
    const seen = await walk(fake, (after) => svc.pageContacts(WS, "SM", { after, limit: 100 }));
    const expected = Array.from({ length: Math.ceil(N / 7) }, (_, k) => id(k * 7));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expected);
  });

  it("candidates for a manual group follow the same rules", async () => {
    const fake = createAudienceDb(t);
    const svc = new SegmentsService(fake.prisma as never);
    const seen = await walk(fake, (after) => svc.candidates(WS, "MG", { after, limit: "100" }));
    const members = new Set(t.segmentMember.filter((m) => m.segmentId === "MG").map((m) => m.contactId));
    const expected = t.contact.map((c) => c.id).filter((x) => !members.has(x));
    expect(seen).toEqual(expected);
  });
});

describe("audience pages: shape, search and errors", () => {
  it("limit defaults to 50 and clamps to 1..100; q matches name, phone or email; any origin", async () => {
    const { svc, t, fake } = setup();
    t.contact.find((c) => c.id === "a4")!.email = "Four@Example.com";
    const all = await svc.pageContacts(WS, "S", {});
    expect(all).toEqual({ items: [expect.objectContaining({ id: "a1" }), expect.objectContaining({ id: "a4" })], nextCursor: null, timedOut: false });
    expect(Object.keys(all.items[0]).sort()).toEqual(["email", "id", "lifecycle", "name", "phone"]);
    expect((await svc.pageContacts(WS, "S", { q: "four@example" })).items.map((x) => x.id)).toEqual(["a4"]);
    expect((await svc.pageContacts(WS, "G", { limit: "1" })).nextCursor).toBe("a1");
    await svc.pageContacts(WS, "H", { limit: 5000 });
    const takes = fake.calls.filter((c) => c.model === "contact" && c.op === "findMany").map((c) => c.args.take);
    expect(takes).toEqual([51, 51, 2, 101]);
  });

  it("candidates on a non-manual audience → 400 not_manual", async () => {
    const { svc } = setup();
    expect(await bodyOf(svc.candidates(WS, "S"))).toMatchObject({ statusCode: 400, message: "audiences.not_manual" });
  });
});

describe("count timeout returns null", () => {
  it("GET /segments/:id/count and POST /segments/preview answer 200 with {count: null, timedOut: true}", async () => {
    const { fake, ctrl } = setup();
    const events = timeoutCounts(fake);
    await expect(ctrl.count(WS, "S")).resolves.toEqual({ count: null, countedAt: expect.any(String), timedOut: true });
    await expect(ctrl.preview(WS, { rules: tree(lead) as never })).resolves.toEqual({ count: null, timedOut: true, sample: [], issues: [] });
    // SET LOCAL precedes the count, in the same transaction.
    const byTx = new Map<string, string[]>();
    for (const e of events) {
      const [txId, what] = [e.slice(0, e.indexOf(":")), e.slice(e.indexOf(":") + 1)];
      byTx.set(txId, [...(byTx.get(txId) ?? []), what]);
    }
    const withCount = [...byTx.values()].filter((l) => l.includes("count"));
    expect(withCount).toHaveLength(2);
    for (const l of withCount) expect(l).toEqual(["SET LOCAL statement_timeout = 8000", "count"]);
    // Fix I1: a timed-out count is cached as null with countedAt, so it is not retried at once.
    const writes = fake.calls.filter((c) => c.op === "$executeRaw" && /memberCount/.test(c.args.sql));
    expect(writes.map((c) => [c.args.values[0], c.args.values[2], c.args.values[3]])).toEqual([[null, "S", WS]]);
    expect(fake.db.segment.find((r) => r.id === "S")).toMatchObject({ memberCount: null, countedAt: expect.any(Date) });
    // Within 10 s the count route serves the cached timeout without counting again.
    const before = events.filter((e) => e.endsWith(":count")).length;
    await expect(ctrl.count(WS, "S")).resolves.toMatchObject({ count: null, timedOut: true });
    expect(events.filter((e) => e.endsWith(":count")).length).toBe(before);
  });

  it("a member page that times out answers {items: [], timedOut: true}", async () => {
    const { fake, ctrl } = setup();
    const orig = fake.prisma.__tx;
    fake.prisma.__tx = (id: number) => {
      const tx = orig(id);
      tx.contact.findMany = async () => {
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      };
      return tx;
    };
    await expect(ctrl.contacts(WS, "S")).resolves.toEqual({ items: [], nextCursor: null, timedOut: true });
    await expect(ctrl.candidates(WS, "G")).resolves.toEqual({ items: [], nextCursor: null, timedOut: true });
  });

  it("AUDIENCE_COUNT_TIMEOUT_MS overrides the statement timeout", async () => {
    const { fake, svc } = setup();
    const prev = process.env.AUDIENCE_COUNT_TIMEOUT_MS;
    process.env.AUDIENCE_COUNT_TIMEOUT_MS = "2500";
    try {
      await svc.count(WS, "S");
    } finally {
      if (prev === undefined) delete process.env.AUDIENCE_COUNT_TIMEOUT_MS;
      else process.env.AUDIENCE_COUNT_TIMEOUT_MS = prev;
    }
    expect(fake.calls.find((c) => c.op === "$executeRawUnsafe")!.args.sql).toBe("SET LOCAL statement_timeout = 2500");
  });

  it("other errors are not swallowed", async () => {
    const { fake, svc } = setup();
    const orig = fake.prisma.__tx;
    fake.prisma.__tx = (id: number) => {
      const tx = orig(id);
      tx.contact.count = async () => {
        throw new Error("connection reset");
      };
      return tx;
    };
    await expect(svc.count(WS, "S")).rejects.toThrow("connection reset");
  });
});

describe("segment list recomputes stale counts with bounded concurrency", () => {
  it("at most 3 counts in flight; fresh rows from cache; raw-SQL cache write keeps updatedAt; manual by membership", async () => {
    const t = predicateWorld();
    const updatedAt = new Date("2026-02-01T00:00:00Z");
    for (let i = 0; i < 10; i++) {
      t.segment.push(seg(`stale${i}`, WS, "crm", { rules: tree(lead), memberCount: 99, countedAt: new Date(NOW.getTime() - 6 * 60_000), updatedAt }));
    }
    t.segment.push(seg("fresh", WS, "crm", { rules: tree(lead), memberCount: 7, countedAt: new Date(NOW.getTime() - 60_000), updatedAt }));
    const fake = createAudienceDb(t);
    let inFlight = 0;
    let peak = 0;
    let counts = 0;
    const orig = fake.prisma.__tx;
    fake.prisma.__tx = (id: number) => {
      const tx = orig(id);
      const count = tx.contact.count;
      tx.contact.count = async (args: unknown) => {
        counts++;
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return count(args);
      };
      return tx;
    };
    const svc = new SegmentsService(fake.prisma as never);
    const rows = await svc.listRows(WS, { now: NOW });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    // S (no cache) + 10 stale; "fresh" is not recounted.
    expect(counts).toBe(11);
    const fresh = rows.find((r) => r.id === "fresh")!;
    expect(fresh).toMatchObject({ count: 7, timedOut: false, countedAt: new Date(NOW.getTime() - 60_000).toISOString() });
    const stale = rows.find((r) => r.id === "stale0")!;
    expect(stale).toMatchObject({ count: 2, countedAt: NOW.toISOString(), rulesSource: "rules", issues: [] });
    const writes = fake.calls.filter((c) => c.op === "$executeRaw");
    expect(writes).toHaveLength(11);
    for (const w of writes) expect(w.args.sql).toBe('UPDATE "Segment" SET "memberCount" = ?, "countedAt" = ? WHERE "id" = ? AND "workspaceId" = ?');
    expect(fake.calls.filter((c) => c.model === "segment" && c.op === "update")).toEqual([]);
    const row = t.segment.find((s) => s.id === "stale0")!;
    expect(row).toMatchObject({ memberCount: 2, countedAt: NOW, updatedAt });
    expect(rows.find((r) => r.id === "G")).toMatchObject({ origin: "manual", count: 2, rules: null, rulesSource: null });
    expect(fake.calls.filter((c) => c.model === "segmentMember" && c.op === "count").map((c) => c.args.where.segmentId).sort()).toEqual(["G", "H"]);
  });
});

describe("segment list: one overall count deadline and cached timeouts (fix I1)", () => {
  function staleWorld(n: number) {
    const t = predicateWorld();
    for (let i = 0; i < n; i++) {
      t.segment.push(seg(`stale${i}`, WS, "crm", { rules: tree(lead), memberCount: null, countedAt: null }));
    }
    return t;
  }

  it("10 stale audiences whose counts time out, listed twice: the second list runs no counts", async () => {
    const fake = createAudienceDb(staleWorld(10));
    const events = timeoutCounts(fake);
    const svc = new SegmentsService(fake.prisma as never);
    const first = await svc.listRows(WS, { now: NOW });
    const counted = events.filter((e) => e.endsWith(":count")).length;
    expect(counted).toBe(11); // S + the 10 stale ones
    for (const r of first.filter((x) => x.origin === "crm")) {
      expect(r).toMatchObject({ count: null, timedOut: true, countedAt: NOW.toISOString() });
    }
    expect(fake.db.segment.filter((r) => r.origin === "crm").every((r) => r.memberCount === null && r.countedAt?.getTime() === NOW.getTime())).toBe(true);

    const second = await svc.listRows(WS, { now: new Date(NOW.getTime() + 60_000) });
    expect(events.filter((e) => e.endsWith(":count")).length).toBe(counted);
    for (const r of second.filter((x) => x.origin === "crm")) expect(r).toMatchObject({ count: null, timedOut: true });

    // After the 5-minute TTL they are retried.
    await svc.listRows(WS, { now: new Date(NOW.getTime() + 6 * 60_000) });
    expect(events.filter((e) => e.endsWith(":count")).length).toBe(counted * 2);
  });

  it("the list stops counting at its deadline: late rows keep a stale count or answer null, uncached", async () => {
    const t = staleWorld(10);
    t.segment.find((r) => r.id === "stale9")!.memberCount = 42;
    t.segment.find((r) => r.id === "stale9")!.countedAt = new Date(NOW.getTime() - 60 * 60_000);
    const fake = createAudienceDb(t);
    let counts = 0;
    const orig = fake.prisma.__tx;
    fake.prisma.__tx = (id: number) => {
      const tx = orig(id);
      const count = tx.contact.count;
      tx.contact.count = async (args: unknown) => {
        counts++;
        await new Promise((r) => setTimeout(r, 80));
        return count(args);
      };
      return tx;
    };
    const prev = process.env.AUDIENCE_LIST_DEADLINE_MS;
    process.env.AUDIENCE_LIST_DEADLINE_MS = "150";
    let rows: Awaited<ReturnType<SegmentsService["listRows"]>> = [];
    const started = Date.now();
    try {
      rows = await new SegmentsService(fake.prisma as never).listRows(WS, { now: NOW });
    } finally {
      if (prev === undefined) delete process.env.AUDIENCE_LIST_DEADLINE_MS;
      else process.env.AUDIENCE_LIST_DEADLINE_MS = prev;
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(counts).toBeGreaterThan(0);
    expect(counts).toBeLessThan(11);
    // Every statement timeout handed to a count fits inside the remaining list budget.
    for (const c of fake.calls.filter((x) => x.op === "$executeRawUnsafe")) {
      expect(Number(/= (\d+)$/.exec(c.args.sql)![1])).toBeLessThanOrEqual(150);
    }
    const crm = rows.filter((r) => r.origin === "crm");
    const late = crm.filter((r) => r.count !== 2);
    expect(crm.filter((r) => r.count === 2)).toHaveLength(counts);
    expect(late.length).toBe(11 - counts);
    for (const r of late) {
      if (r.id === "stale9") expect(r).toMatchObject({ count: 42, timedOut: false });
      else expect(r).toMatchObject({ count: null, timedOut: true, countedAt: null });
    }
    // Rows skipped by the deadline are not cached: only the counted ones were written.
    expect(fake.calls.filter((c) => c.op === "$executeRaw")).toHaveLength(counts);
  });
});

describe("reference chain depth is capped on save and preview (fix I2)", () => {
  function chain(n: number) {
    const t = predicateWorld();
    for (let i = 1; i <= n; i++) {
      const rules = i === n ? tree(lead) : tree({ field: "group", op: "in", segmentId: `S${i + 1}` });
      t.segment.push(seg(`S${i}`, WS, "crm", { rules }));
    }
    return t;
  }

  it("a chain at the cap (5) saves and previews; one deeper is 400 invalid_rules too_deep", async () => {
    const ok = setup(createAudienceDb(chain(5)));
    await expect(ok.svc.save(WS, { name: "T", rules: tree({ field: "group", op: "in", segmentId: "S1" }) })).resolves.toMatchObject({ issues: [] });
    await expect(ok.svc.preview(WS, { rules: tree({ field: "group", op: "not_in", segmentId: "S1" }) })).resolves.toMatchObject({ issues: [] });

    const deep = setup(createAudienceDb(chain(6)));
    const t6 = tree(lead, { op: "or", rules: [{ field: "group", op: "not_in", segmentId: "S1" }, lead] });
    for (const p of [deep.svc.save(WS, { name: "T", rules: t6 }), deep.svc.preview(WS, { rules: t6 })]) {
      expect(await bodyOf(p)).toEqual({ statusCode: 400, message: "audiences.invalid_rules", path: [1, 0], reason: "too_deep", max: 5 });
    }
    expect(deep.fake.calls.filter((c) => c.op === "create" || c.op === "update")).toEqual([]);
  });

  it("the longest chain counts, not the shortest path the walk finds first", async () => {
    // T names S4 directly (1 hop) and S1, whose chain S1 to S6 is 6 long.
    const { svc } = setup(createAudienceDb(chain(6)));
    const t = tree({ field: "group", op: "in", segmentId: "S4" }, { field: "group", op: "in", segmentId: "S1" });
    expect(await bodyOf(svc.save(WS, { name: "T", rules: t }))).toMatchObject({ reason: "too_deep", path: [1] });
  });

  it("a new audience in front of a full chain is rejected", async () => {
    const { svc, t } = setup(createAudienceDb(chain(5)));
    t.segment.push(seg("NEW", WS, "crm", { rules: tree({ field: "group", op: "in", segmentId: "S1" }) }));
    expect(await bodyOf(svc.save(WS, { name: "front", rules: tree({ field: "group", op: "in", segmentId: "NEW" }) }))).toMatchObject({ reason: "too_deep", path: [0] });
  });
});

describe("version conflict returns current", () => {
  it("PATCH with version 3 on a row at 4 → 409 {current} and nothing is written; version 4 → 5", async () => {
    const { ctrl, t, fake } = setup();
    t.segment.push(seg("V", WS, "crm", { rules: tree(lead), version: 4, name: "Before" }));
    const body = await bodyOf(ctrl.update(WS, "V", { name: "Mine", rules: tree({ field: "conversations", op: "none" }) as never, version: 3 }));
    expect(body).toMatchObject({ statusCode: 409, message: "audiences.version_conflict", current: { id: "V", version: 4, name: "Before", rules: tree(lead) } });
    expect(fake.calls.filter((c) => c.op === "update")).toEqual([]);
    const ok = await ctrl.update(WS, "V", { name: "Mine", rules: tree({ field: "conversations", op: "none" }) as never, version: 4 });
    expect(ok).toMatchObject({ version: 5, name: "Mine", rules: tree({ field: "conversations", op: "none" }), filter: { stageAny: ["__sp16_rules_v2__"] } });
    // Older clients may omit the version.
    await expect(ctrl.update(WS, "V", { name: "Old client" })).resolves.toMatchObject({ version: 6 });
  });
});

describe("preview returns count, sample and issues and writes nothing", () => {
  it("count, at most 5 newest contacts, issues; no segment write and no raw statement but the timeout", async () => {
    const { svc, t, fake } = setup();
    for (let i = 0; i < 8; i++) {
      t.contact.push(contact(`n${i}`, WS, { lifecycle: "lead", name: `New ${i}`, phone: `+9665${i}`, createdAt: new Date(NOW.getTime() - i * 60_000) }));
    }
    const res = await svc.preview(WS, { rules: tree(lead, { op: "or", rules: [{ field: "group", op: "in", segmentId: "S" }, { field: "pipeline_stage", op: "in", pipelineId: "P2" }] }) }, { now: NOW });
    expect(res.count).toBe(10);
    expect(res.timedOut).toBe(false);
    expect(res.sample).toEqual(["n0", "n1", "n2", "n3", "n4"].map((id, i) => ({ id, name: `New ${i}`, phone: `+9665${i}` })));
    expect(res.issues).toEqual([{ path: [1, 1], kind: "pipeline_archived" }]);
    expect(fake.calls.filter((c) => c.model === "segment" && (c.op === "update" || c.op === "create"))).toEqual([]);
    expect(fake.calls.filter((c) => c.op === "$executeRaw")).toEqual([]);
    expect(fake.calls.filter((c) => c.op === "$executeRawUnsafe").map((c) => c.args.sql)).toEqual(["SET LOCAL statement_timeout = 8000"]);
  });

  it("a legacy {filter} body still works", async () => {
    const { svc } = setup();
    await expect(svc.preview(WS, { filter: { tagsAll: ["VIP"] } })).resolves.toMatchObject({ count: 1, issues: [] });
  });
});

describe("foreign ids return 404 on SP-16 routes (part 1)", () => {
  it.each([
    ["GET /segments/:id", (c: SegmentsController) => c.detail(WS, "GB")],
    ["GET /segments/:id/contacts", (c: SegmentsController) => c.contacts(WS, "GB")],
    ["GET /segments/:id/count", (c: SegmentsController) => c.count(WS, "GB")],
    ["GET /segments/:id/candidates", (c: SegmentsController) => c.candidates(WS, "GB")],
    ["PATCH /segments/:id", (c: SegmentsController) => c.update(WS, "GB", { name: "x" })],
    ["PATCH /segments/:id (rules)", (c: SegmentsController) => c.update(WS, "GB", { rules: tree(lead) as never })],
    ["POST /segments/preview excludeId", (c: SegmentsController) => c.preview(WS, { rules: tree(lead) as never, excludeId: "GB" })],
  ])("%s with workspace B's id from A → 404 audiences.not_found", async (_route, call) => {
    const { ctrl, t } = setup();
    expect(t.segment.find((s) => s.id === "GB")!.workspaceId).toBe(WS_B);
    let err: unknown;
    try {
      await call(ctrl);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotFoundException);
    expect(audienceErrorBody(err)).toMatchObject({ statusCode: 404, message: "audiences.not_found" });
  });

  it("an hjz audience keeps today's read-only 404 text", async () => {
    const { ctrl } = setup();
    await expect(ctrl.update(WS, "H", { name: "x" })).rejects.toThrow("Segment is managed by HJZ and read-only here");
  });
});

describe("audience detail", () => {
  it("returns the AudienceRow plus the audiences and campaigns that use it", async () => {
    const { ctrl, t } = setup();
    t.segment.push(
      seg("U1", WS, "crm", { name: "Uses G", rules: tree({ op: "or", rules: [lead, { field: "group", op: "not_in", segmentId: "G" }] }) }),
      seg("U2", WS, "crm", { name: "Marked", rules: tree({ field: "group", op: "in", segmentId: "G", missing: true }) }),
    );
    t.campaign.push({ id: "CG", workspaceId: WS, name: "Promo", status: "draft", segmentId: "G", createdAt: NOW });
    const d = await ctrl.detail(WS, "G");
    expect(d).toMatchObject({ id: "G", origin: "manual", count: 2, rules: null, rulesSource: null, issues: [], version: 0, timedOut: false });
    expect(d.references).toEqual({ audiences: [{ id: "U1", name: "Uses G", nameAr: null }], campaigns: [{ id: "CG", name: "Promo", status: "draft" }] });
    const s = await ctrl.detail(WS, "S");
    expect(s).toMatchObject({ rulesSource: "rules", count: 2, issues: [] });
  });

  it("create answers the AudienceRow; legacy create still works", async () => {
    const { ctrl } = setup();
    const row = await ctrl.create(WS, { name: "Smart", rules: tree(lead) as never });
    expect(row).toMatchObject({ name: "Smart", origin: "crm", rulesSource: "rules", version: 0, filter: { lifecycle: ["lead"] }, issues: [] });
    const legacy = await ctrl.create(WS, { name: "Legacy", filter: { tagsAll: ["VIP"] } });
    expect(legacy).toMatchObject({ rulesSource: "legacy", rules: { v: 2, op: "and", rules: [{ field: "tag", op: "has", tag: "VIP" }] } });
    const manual = await ctrl.create(WS, { name: "Manual", origin: "manual" });
    expect(manual).toMatchObject({ origin: "manual", rules: null, filter: {} });
  });
});
