/**
 * SP-16 Task 2 (Review Focus 2, ruling 7): deleting an audience that other
 * smart audiences or campaigns use, over the in-memory evaluator.
 */
import { NotFoundException } from "@nestjs/common";
import { audienceErrorBody } from "./audience-errors";
import { readRules, type AudienceNode, type AudienceRules } from "./audience-rules";
import { createAudienceDb, emptyTables, evaluateContacts, type AudienceTables } from "./audience-test-db";
import { contact, seg, WS, WS_B } from "./__fixtures__/audience-world";
import { SegmentsController } from "./segments.controller";
import { SegmentsService } from "./segments.service";
import { TagsController, TagsService } from "../tags/tags.module";

const tree = (...rules: AudienceNode[]): AudienceRules => ({ v: 2, op: "and", rules });
const inG: AudienceNode = { field: "group", op: "in", segmentId: "G" };
const lead: AudienceNode = { field: "lifecycle", op: "in", values: ["lead"] };

const campaign = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: WS,
  name: `Campaign ${id}`,
  status,
  launchStage: null,
  segmentId: "G",
  createdAt: new Date(`2026-01-0${id.length}T00:00:00Z`),
  ...over,
});

/** Manual group G (k1, k2) is used by smart audience S (`group in G`); N (`group not_in G` AND lead) also uses it. */
function world(campaigns: Array<Record<string, unknown>> = []) {
  const t = emptyTables();
  t.contact.push(contact("k1", WS), contact("k2", WS), contact("k3", WS), contact("b1", WS_B));
  t.segment.push(
    seg("G", WS, "manual"),
    seg("S", WS, "crm", { rules: tree(inG) }),
    seg("N", WS, "crm", { rules: tree({ field: "group", op: "not_in", segmentId: "G" }, lead) }),
    seg("U", WS, "manual"),
    seg("H", WS, "hjz"),
    seg("GB", WS_B, "manual"),
  );
  t.segmentMember.push({ segmentId: "G", contactId: "k1" }, { segmentId: "G", contactId: "k2" });
  t.campaign.push(...campaigns);
  const fake = createAudienceDb(t);
  const svc = new SegmentsService(fake.prisma as never);
  const outbound = { emitSegmentUpserted: jest.fn(async (_ws: string, _id: string) => true), emitSegmentDeleted: jest.fn(async () => true) };
  const ctrl = new SegmentsController(fake.prisma as never, svc, outbound as never);
  const row = (id: string) => fake.db.segment.find((s) => s.id === id);
  const members = async (id: string) => evaluateContacts(fake.db, await svc.resolveContactWhere(WS, id));
  const issues = async (id: string) => (await svc.compile(WS, readRules(row(id)!).tree, { selfId: id })).issues;
  return { fake, db: fake.db, svc, ctrl, outbound, row, members, issues };
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

describe("delete-audience-with-references", () => {
  it("a group used by smart audiences and a draft campaign → 409 audiences.in_use {audiences, campaigns}; nothing changes", async () => {
    const w = world([campaign("cd", "draft")]);
    const before = snapshot(w.db);
    expect(await bodyOf(w.ctrl.remove(WS, "G"))).toEqual({
      status: 409,
      statusCode: 409,
      message: "audiences.in_use",
      // Oldest first, then by id.
      audiences: [
        { id: "N", name: "N", nameAr: null },
        { id: "S", name: "S", nameAr: null },
      ],
      campaigns: [{ id: "cd", name: "Campaign cd", status: "draft" }],
    });
    expect(snapshot(w.db)).toBe(before);
    expect(w.outbound.emitSegmentDeleted).not.toHaveBeenCalled();
    expect(w.outbound.emitSegmentUpserted).not.toHaveBeenCalled();
  });

  it("with confirm: G is deleted, the referencing rules are marked missing (group_missing, nobody for in and not_in), the draft keeps its segmentId", async () => {
    const w = world([campaign("cd", "draft")]);
    expect(await w.members("S")).toEqual(["k1", "k2"]);
    expect(await w.members("N")).toEqual(["k3"]);

    expect(await w.ctrl.remove(WS, "G", "1")).toEqual({ ok: true, audiencesMarked: 2 });
    expect(w.row("G")).toBeUndefined();
    expect(w.outbound.emitSegmentDeleted).toHaveBeenCalledWith(WS, "G");
    // Review m2: the marked audiences are re-emitted to HJZ after commit.
    expect(w.outbound.emitSegmentUpserted.mock.calls.map((c: unknown[]) => c[1]).sort()).toEqual(["N", "S"]);

    expect(w.row("S")!.rules).toEqual(tree({ ...inG, missing: true } as AudienceNode));
    expect(await w.issues("S")).toEqual([{ path: [0], kind: "group_missing" }]);
    expect(await w.members("S")).toEqual([]);
    // `not_in` a deleted group never widens to everyone.
    expect(await w.members("N")).toEqual([]);
    for (const id of ["S", "N"]) expect(w.row(id)!.version).toBe(1);
    expect(w.db.campaign.find((c) => c.id === "cd")!.segmentId).toBe("G");
  });

  it.each([
    ["a scheduled campaign", campaign("cs", "scheduled")],
    ["a campaign whose launchStage is sending", campaign("cl", "launching", { launchStage: "sending" })],
    ["a campaign still planning", campaign("cp", "launching", { launchStage: "planning" })],
    ["a running campaign", campaign("cr", "running", { launchStage: "done" })],
  ])("%s → 409 audiences.in_use_by_campaigns even with confirm, and nothing is deleted", async (_label, live) => {
    const w = world([campaign("cd", "draft"), live]);
    const before = snapshot(w.db);
    for (const confirm of [undefined, "1"]) {
      expect(await bodyOf(w.ctrl.remove(WS, "G", confirm))).toEqual({
        status: 409,
        statusCode: 409,
        message: "audiences.in_use_by_campaigns",
        campaigns: [{ id: live.id, name: live.name, status: live.status }],
      });
    }
    expect(snapshot(w.db)).toBe(before);
  });

  it("finished campaigns do not block (they are listed and need confirm)", async () => {
    const w = world([campaign("cc", "completed", { launchStage: "done" }), campaign("cf", "failed", { launchStage: "failed" })]);
    const body = await bodyOf(w.ctrl.remove(WS, "G"));
    expect(body).toMatchObject({ message: "audiences.in_use", campaigns: [{ id: "cc" }, { id: "cf" }] });
    expect(await w.ctrl.remove(WS, "G", "1")).toEqual({ ok: true, audiencesMarked: 2 });
  });

  it("an unreferenced group deletes without confirm, as before", async () => {
    const w = world();
    expect(await w.ctrl.remove(WS, "U")).toEqual({ ok: true, audiencesMarked: 0 });
    expect(w.row("U")).toBeUndefined();
  });

  it("an hjz group keeps its 404 text; a foreign or unknown id → 404 audiences.not_found", async () => {
    const w = world();
    const before = snapshot(w.db);
    await expect(w.ctrl.remove(WS, "H", "1")).rejects.toThrow("Segment is managed by HJZ and read-only here");
    expect(await bodyOf(w.ctrl.remove(WS, "GB", "1"))).toMatchObject({ status: 404, message: "audiences.not_found" });
    expect(await bodyOf(w.ctrl.remove(WS, "nope"))).toMatchObject({ status: 404, message: "audiences.not_found" });
    expect(snapshot(w.db)).toBe(before);
    expect(w.outbound.emitSegmentDeleted).not.toHaveBeenCalled();
  });

  it("a failure while marking rolls the delete back", async () => {
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
    await expect(w.ctrl.remove(WS, "G", "1")).rejects.toThrow("connection lost while marking");
    expect(snapshot(w.db)).toBe(before);
  });
});

describe("foreign ids return 404 on SP-16 routes (part 2)", () => {
  it("GET /tags/:id/references, DELETE /tags/:id?confirm=1 and DELETE /segments/:id?confirm=1 with workspace B's ids from A", async () => {
    const w = world();
    w.db.tag.push({ id: "tB", workspaceId: WS_B, name: "VIP", color: "0" });
    w.db.segment.push(seg("SB", WS_B, "crm", { rules: tree({ field: "tag", op: "has", tag: "VIP" }) }));
    const tags = new TagsController(new TagsService(w.fake.prisma as never));
    const before = snapshot(w.db);
    await expect(tags.references(WS, "tB")).rejects.toThrow(NotFoundException);
    await expect(tags.remove(WS, "tB", "1")).rejects.toThrow(NotFoundException);
    for (const id of ["GB", "SB"]) {
      expect(await bodyOf(w.ctrl.remove(WS, id, "1"))).toMatchObject({ status: 404, message: "audiences.not_found" });
    }
    expect(snapshot(w.db)).toBe(before);
  });
});

describe("F2 and batching on the audience delete", () => {
  it("referrers of the marked audiences are cleared transitively; N audiences take O(1) statements", async () => {
    const run = async (n: number) => {
      const w = world();
      for (let i = 0; i < n; i++) {
        w.db.segment.push(
          seg(`S${i}`, WS, "crm", { rules: tree(inG) }),
          seg(`T${i}`, WS, "crm", { rules: tree({ field: "group", op: "not_in", segmentId: `S${i}` }) }),
        );
      }
      w.db.segment.push(seg("Z", WS, "crm", { rules: tree(lead) }));
      for (const s of w.db.segment) Object.assign(s, { memberCount: 42, countedAt: new Date("2026-11-15T00:00:00Z") });
      expect(await w.ctrl.remove(WS, "G", "1")).toEqual({ ok: true, audiencesMarked: 2 + n });
      return w;
    };
    const small = await run(1);
    const large = await run(25);
    for (const id of ["S", "N", "S0", "T0", "S24", "T24"]) expect(large.row(id)).toMatchObject({ memberCount: null, countedAt: null });
    expect(large.row("T3")!.version).toBe(0);
    expect(large.row("Z")).toMatchObject({ memberCount: 42 });
    const statements = (w: ReturnType<typeof world>) => w.fake.calls.filter((c) => c.tx !== null && c.model !== "$tx").length;
    expect(statements(large)).toBe(statements(small));
    // HJZ re-sync covers the cleared referrers too.
    expect(large.outbound.emitSegmentUpserted.mock.calls.map((c: unknown[]) => c[1])).toEqual(expect.arrayContaining(["S", "N", "S0", "T0"]));
  });
});
