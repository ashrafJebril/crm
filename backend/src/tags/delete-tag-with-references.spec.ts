/**
 * SP-16 Task 2 (Review Focus 2, ruling 7): deleting, renaming and merging a
 * tag that smart audiences name, over the in-memory evaluator. Membership
 * is always read back through `SegmentsService.resolveContactWhere`, the
 * resolver every consumer (contacts list, campaigns, HJZ) uses.
 */
import { NotFoundException } from "@nestjs/common";
import { audienceErrorBody } from "../segments/audience-errors";
import { LEGACY_SENTINEL_JSON, readRules, type AudienceNode, type AudienceRules } from "../segments/audience-rules";
import { createAudienceDb, emptyTables, evaluateContacts, type AudienceTables, type Row } from "../segments/audience-test-db";
import { contact, seg, WS, WS_B } from "../segments/__fixtures__/audience-world";
import { SegmentsService } from "../segments/segments.service";
import { TagsController, TagsService } from "./tags.module";

const tree = (...rules: AudienceNode[]): AudienceRules => ({ v: 2, op: "and", rules });
const has = (tag: string): AudienceNode => ({ field: "tag", op: "has", tag });
const lead: AudienceNode = { field: "lifecycle", op: "in", values: ["lead"] };

const tagsOf = (c: Row): string[] => {
  try {
    const v = JSON.parse(c.tags);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/**
 * The tag SQL on `Contact.tags`, emulated: the delete (`FILTER (WHERE e <> name)`)
 * and the rename (`DISTINCT CASE WHEN e = from THEN to`). Exact elements only.
 */
function tagSql(sql: string, values: unknown[], db: AudienceTables): number | undefined {
  if (!sql.includes('UPDATE "Contact"')) return undefined;
  if (sql.includes("FILTER (WHERE e <>")) {
    const [name, ws] = values as [string, string];
    let n = 0;
    for (const c of db.contact) {
      if (c.workspaceId !== ws || !tagsOf(c).includes(name)) continue;
      c.tags = JSON.stringify(tagsOf(c).filter((t) => t !== name));
      n++;
    }
    return n;
  }
  if (sql.includes("CASE WHEN e =")) {
    const [from, to, ws] = values as [string, string, string];
    let n = 0;
    for (const c of db.contact) {
      if (c.workspaceId !== ws || !tagsOf(c).includes(from)) continue;
      c.tags = JSON.stringify([...new Set(tagsOf(c).map((t) => (t === from ? to : t)))]);
      n++;
    }
    return n;
  }
  throw new Error(`unexpected Contact SQL: ${sql}`);
}

/**
 * Tag VIP is used by smart audience A (`tag has VIP` AND `lifecycle in lead`),
 * legacy audience B (`{"tagsAny":["VIP","Gold"]}`) and smart audience C
 * (`tag not_has VIP`). D is a manual group; E uses VIPER.
 */
function world() {
  const t = emptyTables();
  t.contact.push(
    contact("k1", WS, { tags: '["VIP"]', lifecycle: "lead" }),
    contact("k2", WS, { tags: '["VIP","Gold"]', lifecycle: "customer" }),
    contact("k3", WS, { tags: '["Gold"]', lifecycle: "lead" }),
    contact("k4", WS, { tags: '["VIPER"]', lifecycle: "lead" }),
    contact("k5", WS, { tags: "[]", lifecycle: "lead" }),
    contact("b1", WS_B, { tags: '["VIP"]', lifecycle: "lead" }),
  );
  t.tag.push(
    { id: "tVIP", workspaceId: WS, name: "VIP", color: "0" },
    { id: "tVIPER", workspaceId: WS, name: "VIPER", color: "30" },
    { id: "tGold", workspaceId: WS, name: "Gold", color: "60" },
    { id: "tPremium", workspaceId: WS, name: "Premium", color: "90" },
    { id: "tLonely", workspaceId: WS, name: "Lonely", color: "120" },
    { id: "tB", workspaceId: WS_B, name: "VIP", color: "0" },
  );
  t.segment.push(
    seg("A", WS, "crm", { rules: tree(has("VIP"), lead), filter: JSON.stringify({ tagsAll: ["VIP"], lifecycle: ["lead"] }) }),
    seg("B", WS, "crm", { filter: JSON.stringify({ tagsAny: ["VIP", "Gold"] }) }),
    seg("C", WS, "crm", { rules: tree({ field: "tag", op: "not_has", tag: "VIP" }), filter: LEGACY_SENTINEL_JSON }),
    seg("D", WS, "manual"),
    seg("E", WS, "crm", { rules: tree(has("VIPER")), filter: JSON.stringify({ tagsAll: ["VIPER"] }) }),
    seg("FB", WS_B, "crm", { rules: tree(has("VIP")) }),
  );
  t.segmentMember.push({ segmentId: "D", contactId: "k1" });
  const fake = createAudienceDb(t, { raw: tagSql });
  // HJZ emits as a spy; each call records the audience row as it was when emitted (after commit).
  const emitted: Array<{ id: string; rules: unknown; filter: string }> = [];
  const outbound = {
    emitSegmentUpserted: jest.fn(async (_ws: string, id: string) => {
      const r = fake.db.segment.find((x) => x.id === id);
      emitted.push({ id, rules: r ? JSON.parse(JSON.stringify(r.rules)) : null, filter: r?.filter });
      return true;
    }),
  };
  const tags = new TagsService(fake.prisma as never, outbound as never);
  const ctrl = new TagsController(tags);
  const segments = new SegmentsService(fake.prisma as never);
  const members = async (id: string) => evaluateContacts(fake.db, await segments.resolveContactWhere(WS, id));
  const issues = async (id: string) => (await segments.compile(WS, readRules(row(id)).tree, { selfId: id })).issues;
  const row = (id: string) => fake.db.segment.find((s) => s.id === id)!;
  return { fake, db: fake.db, tags, ctrl, members, issues, row, outbound, emitted };
}

async function bodyOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return { status: (e as { getStatus?: () => number }).getStatus?.(), ...audienceErrorBody(e) };
  }
  throw new Error("expected a rejection");
}

const snapshot = (db: AudienceTables) => JSON.stringify(db);

describe("delete-tag-in-rule warns with affected audiences", () => {
  it("GET /tags/:id/references lists A, B and C (not the manual group D, not VIPER's E, not another workspace)", async () => {
    const w = world();
    expect(await w.ctrl.references(WS, "tVIP")).toEqual({
      audiences: [
        { id: "A", name: "A", nameAr: null },
        { id: "B", name: "B", nameAr: null },
        { id: "C", name: "C", nameAr: null },
      ],
    });
    expect(await w.ctrl.references(WS, "tVIPER")).toEqual({ audiences: [{ id: "E", name: "E", nameAr: null }] });
  });

  it("DELETE /tags/:id without confirm → 409 tags.in_use_by_audiences {audiences} and NOTHING changes", async () => {
    const w = world();
    const before = snapshot(w.db);
    expect(await bodyOf(w.ctrl.remove(WS, "tVIP"))).toEqual({
      status: 409,
      statusCode: 409,
      message: "tags.in_use_by_audiences",
      audiences: [
        { id: "A", name: "A", nameAr: null },
        { id: "B", name: "B", nameAr: null },
        { id: "C", name: "C", nameAr: null },
      ],
    });
    expect(snapshot(w.db)).toBe(before);
    // No write was even attempted.
    expect(w.fake.calls.filter((c) => c.op === "update" || c.op === "delete" || c.op === "$executeRaw")).toEqual([]);
    expect(tagsOfId(w.db, "k1")).toEqual(["VIP"]);
    expect(w.db.tag.some((t) => t.id === "tVIP")).toBe(true);
  });

  it("DELETE /tags/:id?confirm=1 → 200; contacts lose VIP; the rules are marked missing (never dropped); nobody is widened", async () => {
    const w = world();
    const beforeB = await w.members("B");
    expect(beforeB).toEqual(["k1", "k2", "k3"]);
    const eBefore = JSON.stringify(w.row("E"));

    const res = await w.ctrl.remove(WS, "tVIP", "1");
    expect(res).toEqual({ ok: true, contactsUpdated: 2, audiencesMarked: 3 });

    // Contacts lose VIP and keep VIPER; another workspace is untouched.
    expect(tagsOfId(w.db, "k1")).toEqual([]);
    expect(tagsOfId(w.db, "k2")).toEqual(["Gold"]);
    expect(tagsOfId(w.db, "k4")).toEqual(["VIPER"]);
    expect(tagsOfId(w.db, "b1")).toEqual(["VIP"]);
    expect(w.db.tag.map((t) => t.id)).not.toContain("tVIP");

    // A: the rule is kept and marked; A matches nobody.
    expect(w.row("A").rules).toEqual(tree({ ...has("VIP"), missing: true } as AudienceNode, lead));
    expect(await w.members("A")).toEqual([]);

    // B: converted to rules, Gold intact, VIP marked; Gold holders only, never more than before.
    expect(w.row("B").rules).toEqual(tree({ op: "or", rules: [{ ...has("VIP"), missing: true } as AudienceNode, has("Gold")] }));
    expect(w.row("B").filter).toBe(LEGACY_SENTINEL_JSON);
    const afterB = await w.members("B");
    expect(afterB).toEqual(["k2", "k3"]);
    expect(afterB.every((id) => beforeB.includes(id))).toBe(true);

    // C (`not_has VIP`) matches nobody, not everyone.
    expect(await w.members("C")).toEqual([]);

    for (const id of ["A", "B", "C"]) {
      expect(await w.issues(id)).toEqual([expect.objectContaining({ kind: "tag_deleted" })]);
      expect(w.row(id).version).toBe(1);
      expect(w.row(id).filter).toBe(LEGACY_SENTINEL_JSON);
      expect(w.row(id).memberCount).toBeNull();
    }
    // E (VIPER), the manual group and another workspace's audience are untouched.
    expect(JSON.stringify(w.row("E"))).toBe(eBefore);
    expect(await w.members("D")).toEqual(["k1"]);
    expect(w.row("FB").rules).toEqual(tree(has("VIP")));
    // Every write happened inside one transaction, after the audience lock.
    const writes = w.fake.calls.filter((c) => ["update", "delete", "$executeRaw"].includes(c.op));
    expect(new Set(writes.map((c) => c.tx)).size).toBe(1);
    expect(writes[0].args.sql).toContain("pg_advisory_xact_lock");
  });

  it("a tag with no references deletes with no confirmation, as today", async () => {
    const w = world();
    w.db.contact[4].tags = '["Lonely"]';
    expect(await w.ctrl.remove(WS, "tLonely")).toEqual({ ok: true, contactsUpdated: 1, audiencesMarked: 0 });
    expect(w.db.tag.map((t) => t.id)).not.toContain("tLonely");
    expect(w.db.segment.every((s) => s.version === 0)).toBe(true);
  });

  it("a foreign tag id → 404 on references and on delete (confirmed or not), and nothing changes", async () => {
    const w = world();
    const before = snapshot(w.db);
    await expect(w.ctrl.references(WS, "tB")).rejects.toThrow(NotFoundException);
    await expect(w.ctrl.remove(WS, "tB")).rejects.toThrow(NotFoundException);
    await expect(w.ctrl.remove(WS, "tB", "1")).rejects.toThrow(NotFoundException);
    await expect(w.ctrl.remove(WS, "nope", "1")).rejects.toThrow(NotFoundException);
    expect(snapshot(w.db)).toBe(before);
  });

  it("a failure while marking rolls everything back: contacts, rules and the catalog row", async () => {
    const w = world();
    const before = snapshot(w.db);
    const orig = w.fake.prisma.__tx;
    w.fake.prisma.__tx = (id: number) => {
      const tx = orig(id);
      // Fail the LAST write (the count-cache clear), after the marks and the delete ran.
      const raw = tx.$executeRaw;
      tx.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join("?").includes('"countedAt" = NULL')) throw new Error("connection lost while marking");
        return raw(strings, ...values);
      };
      return tx;
    };
    await expect(w.ctrl.remove(WS, "tVIP", "1")).rejects.toThrow("connection lost while marking");
    expect(snapshot(w.db)).toBe(before);
  });

  it("a reference that appears after the unconfirmed check still answers 409 inside the transaction (rolled back)", async () => {
    const w = world();
    w.db.segment.splice(0, w.db.segment.length, ...w.db.segment.filter((s) => !["A", "B", "C"].includes(s.id)));
    w.db.contact[4].tags = '["Lonely"]';
    const orig = w.fake.prisma.__tx;
    w.fake.prisma.__tx = (id: number) => {
      // A concurrent save lands between the check and the transaction.
      if (!w.db.segment.some((s) => s.id === "LATE")) w.db.segment.push(seg("LATE", WS, "crm", { rules: tree(has("Lonely")) }));
      return orig(id);
    };
    const body = await bodyOf(w.ctrl.remove(WS, "tLonely"));
    expect(body).toMatchObject({ status: 409, message: "tags.in_use_by_audiences", audiences: [{ id: "LATE" }] });
    expect(tagsOfId(w.db, "k5")).toEqual(["Lonely"]);
    expect(w.db.tag.some((t) => t.id === "tLonely")).toBe(true);
  });
});

describe("tag rename and merge rewrite rules", () => {
  it("rename VIP → Premium rewrites A's, B's and C's rules and filters (exact elements; VIPER untouched)", async () => {
    const w = world();
    w.db.tag.splice(w.db.tag.findIndex((t) => t.id === "tPremium"), 1);
    const res = await w.tags.update(WS, "tVIP", { name: "Premium" });
    expect(res.segmentsUpdated).toBe(3);
    expect(res.contactsUpdated).toBe(2);

    expect(w.row("A").rules).toEqual(tree(has("Premium"), lead));
    expect(JSON.parse(w.row("A").filter)).toEqual({ tagsAll: ["Premium"], lifecycle: ["lead"] });
    expect(w.row("A").version).toBe(1);
    // B stays legacy: its filter arrays are rewritten.
    expect(w.row("B").rules).toBeNull();
    expect(JSON.parse(w.row("B").filter)).toEqual({ tagsAny: ["Premium", "Gold"] });
    // C has no legacy projection: the sentinel stays.
    expect(w.row("C").rules).toEqual(tree({ field: "tag", op: "not_has", tag: "Premium" }));
    expect(w.row("C").filter).toBe(LEGACY_SENTINEL_JSON);
    // VIPER is never touched.
    expect(w.row("E").rules).toEqual(tree(has("VIPER")));
    expect(w.row("E").version).toBe(0);
    expect(tagsOfId(w.db, "k4")).toEqual(["VIPER"]);

    // Membership is unchanged by a rename.
    expect(await w.members("A")).toEqual(["k1"]);
    expect(await w.members("B")).toEqual(["k1", "k2", "k3"]);
    expect(await w.members("C")).toEqual(["k3", "k4", "k5"]);
  });

  it("merge VIP and Gold into Premium dedupes inside an `or` group; segmentsUpdated counts each changed audience once", async () => {
    const w = world();
    w.db.segment.push(
      seg("F", WS, "crm", {
        rules: tree({ op: "or", rules: [has("VIP"), has("Gold")] }, lead),
        filter: JSON.stringify({ tagsAny: ["VIP", "Gold"], lifecycle: ["lead"] }),
      }),
    );
    const res = await w.tags.merge(WS, ["tVIP", "tGold"], "tPremium");
    // A, B, C and F; F changed for both names but counts once.
    expect(res.segmentsUpdated).toBe(4);
    expect(w.row("F").rules).toEqual(tree({ op: "or", rules: [has("Premium")] }, lead));
    expect(JSON.parse(w.row("F").filter)).toEqual({ tagsAny: ["Premium"], lifecycle: ["lead"] });
    expect(w.row("F").version).toBe(1);
    expect(JSON.parse(w.row("B").filter)).toEqual({ tagsAny: ["Premium"] });
    expect(w.row("E").rules).toEqual(tree(has("VIPER")));
    expect(await w.members("F")).toEqual(["k1", "k3"]);
    expect(w.db.tag.map((t) => t.id).sort()).toEqual(["tB", "tLonely", "tPremium", "tVIPER"]);
  });
});

function tagsOfId(db: AudienceTables, id: string): string[] {
  return tagsOf(db.contact.find((c) => c.id === id)!);
}

describe("HJZ re-sync, version and count cache after marking, rename and merge (review m1, m2)", () => {
  const ids = (w: ReturnType<typeof world>) => w.outbound.emitSegmentUpserted.mock.calls.map((c) => c[1]).sort();
  const flush = () => new Promise((r) => setImmediate(r));

  it("a confirmed delete re-emits every marked audience after commit (the emitted state is the marked one)", async () => {
    const w = world();
    await w.ctrl.remove(WS, "tVIP", "1");
    await flush();
    expect(ids(w)).toEqual(["A", "B", "C"]);
    expect(w.outbound.emitSegmentUpserted.mock.calls.every((c) => c[0] === WS)).toBe(true);
    for (const e of w.emitted) expect(e.filter).toBe(LEGACY_SENTINEL_JSON);
  });

  it("no emit on a 409, on a rolled-back delete, or for an unreferenced tag", async () => {
    const w = world();
    await bodyOf(w.ctrl.remove(WS, "tVIP"));
    w.db.contact[4].tags = '["Lonely"]';
    await w.ctrl.remove(WS, "tLonely");
    const orig = w.fake.prisma.__tx;
    w.fake.prisma.__tx = (id: number) => {
      const tx = orig(id);
      const raw = tx.$executeRaw;
      tx.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join("?").includes("jsonb_to_recordset")) throw new Error("boom");
        return raw(strings, ...values);
      };
      return tx;
    };
    await expect(w.ctrl.remove(WS, "tVIP", "1")).rejects.toThrow("boom");
    await flush();
    expect(w.outbound.emitSegmentUpserted).not.toHaveBeenCalled();
  });

  it("an emit failure never fails the delete (best-effort)", async () => {
    const w = world();
    w.outbound.emitSegmentUpserted.mockRejectedValue(new Error("hjz down"));
    expect(await w.ctrl.remove(WS, "tVIP", "1")).toMatchObject({ ok: true, audiencesMarked: 3 });
    await flush();
  });

  it("a rename bumps version on legacy rows too (m1) and re-emits every rewritten audience", async () => {
    const w = world();
    w.db.tag.splice(w.db.tag.findIndex((t) => t.id === "tPremium"), 1);
    await w.tags.update(WS, "tVIP", { name: "Premium" });
    await flush();
    expect(w.row("B").rules).toBeNull();
    expect(w.row("B").version).toBe(1);
    expect(w.row("E").version).toBe(0);
    expect(ids(w)).toEqual(["A", "B", "C"]);
  });

  it("a merge clears the count cache of every rewritten audience and re-emits them", async () => {
    const w = world();
    const at = new Date("2026-11-01T00:00:00Z");
    for (const s of w.db.segment) Object.assign(s, { memberCount: 7, countedAt: at });
    await w.tags.merge(WS, ["tVIP", "tGold"], "tPremium");
    await flush();
    for (const id of ["A", "B", "C"]) {
      expect(w.row(id)).toMatchObject({ memberCount: null, countedAt: null });
    }
    expect(w.row("B").version).toBe(1);
    expect(w.row("E")).toMatchObject({ memberCount: 7, countedAt: at, version: 0 });
    expect(ids(w)).toEqual(["A", "B", "C"]);
  });
});

describe("F2: counts are cleared for merge targets and group referrers (live verification)", () => {
  const AT = new Date("2026-11-15T19:56:15.113Z");
  const counted = (w: ReturnType<typeof world>) => {
    for (const s of w.db.segment) Object.assign(s, { memberCount: 1819, countedAt: AT });
  };

  it("a merge into Gold clears a `tag has Gold` audience that was not rewritten (and its group referrers)", async () => {
    const w = world();
    w.db.segment.push(
      seg("HG", WS, "crm", { rules: tree(has("Gold")), filter: JSON.stringify({ tagsAll: ["Gold"] }) }),
      seg("RG", WS, "crm", { rules: tree({ field: "group", op: "in", segmentId: "HG" }) }),
    );
    counted(w);
    await w.tags.merge(WS, ["tVIP"], "tGold");
    // HG names the target only: its rules are unchanged, its count is not.
    expect(w.row("HG").rules).toEqual(tree(has("Gold")));
    expect(w.row("HG").version).toBe(0);
    for (const id of ["HG", "RG", "A", "B", "C"]) expect(w.row(id)).toMatchObject({ memberCount: null, countedAt: null });
    // Unrelated audiences keep their cache.
    expect(w.row("E")).toMatchObject({ memberCount: 1819, countedAt: AT });
    expect(w.row("FB")).toMatchObject({ memberCount: 1819 });
  });

  it("a confirmed tag delete clears the referrers of a marked audience, transitively (in and not_in)", async () => {
    const w = world();
    w.db.segment.push(
      seg("R1", WS, "crm", { rules: tree({ field: "group", op: "in", segmentId: "A" }) }),
      seg("R2", WS, "crm", { rules: tree({ field: "group", op: "not_in", segmentId: "R1" }) }),
      seg("R3", WS, "crm", { rules: tree({ field: "group", op: "in", segmentId: "E" }) }),
    );
    counted(w);
    await w.ctrl.remove(WS, "tVIP", "1");
    for (const id of ["A", "B", "C", "R1", "R2"]) expect(w.row(id)).toMatchObject({ memberCount: null, countedAt: null });
    // Their rules are untouched (only A, B and C are marked).
    expect(w.row("R1").version).toBe(0);
    for (const id of ["E", "R3"]) expect(w.row(id)).toMatchObject({ memberCount: 1819, countedAt: AT });
  });
});

describe("tag operations: one longer transaction, O(1) statements in the number of audiences", () => {
  const TX = { timeout: 30_000, maxWait: 10_000 };
  const txOptions = (w: ReturnType<typeof world>) => w.fake.calls.filter((c) => c.model === "$tx" && c.op === "begin").map((c) => c.args);
  /** Statements run inside transactions (reads and writes), excluding the begin/end markers. */
  const statements = (w: ReturnType<typeof world>) => w.fake.calls.filter((c) => c.tx !== null && c.model !== "$tx").length;
  const withAudiences = (n: number) => {
    const w = world();
    for (let i = 0; i < n; i++) {
      w.db.segment.push(
        seg(`V${i}`, WS, "crm", { rules: tree(has("VIP"), lead), filter: JSON.stringify({ tagsAll: ["VIP"], lifecycle: ["lead"] }) }),
        seg(`L${i}`, WS, "crm", { filter: JSON.stringify({ tagsAny: ["VIP"] }) }),
        seg(`R${i}`, WS, "crm", { rules: tree({ field: "group", op: "in", segmentId: `V${i}` }) }),
      );
    }
    return w;
  };

  it.each([
    ["rename", (w: ReturnType<typeof world>) => (w.db.tag.splice(w.db.tag.findIndex((t) => t.id === "tPremium"), 1), w.tags.update(WS, "tVIP", { name: "Premium" }))],
    ["merge", (w: ReturnType<typeof world>) => w.tags.merge(WS, ["tVIP"], "tGold")],
    ["confirmed delete", (w: ReturnType<typeof world>) => w.ctrl.remove(WS, "tVIP", "1")],
  ] as const)("%s: transaction options {timeout: 30 000, maxWait: 10 000}; 3 and 60 extra audiences take the same number of statements", async (_label, op) => {
    const small = withAudiences(1);
    const large = withAudiences(20);
    await op(small);
    await op(large);
    expect(txOptions(small)).toEqual([TX]);
    expect(txOptions(large)).toEqual([TX]);
    expect(statements(large)).toBe(statements(small));
    // The writes still happened: every VIP audience was rewritten (rename/merge) or marked (delete), with version + 1.
    for (let i = 0; i < 20; i++) {
      expect(large.row(`V${i}`).version).toBe(1);
      expect(large.row(`L${i}`).version).toBe(1);
    }
  });
});
