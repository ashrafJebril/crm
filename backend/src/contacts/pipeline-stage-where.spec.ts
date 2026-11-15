/**
 * SP-16 ruling 9 (Task 2 B4): the contacts list and the audience compiler
 * share ONE pipeline-stage predicate, so they select the same contacts.
 */
import { compileAudience } from "../segments/audience-compiler";
import { loadLookups } from "../segments/audience-lookups";
import type { AudienceRules } from "../segments/audience-rules";
import { createAudienceDb, evaluateContacts } from "../segments/audience-test-db";
import { NOW, predicateWorld, WS } from "../segments/__fixtures__/audience-world";
import { buildContactWhere } from "./contact-filter";
import { pipelineStageWhere } from "./pipeline-stage-where";

const stageRule = (pipelineId: string, stageId?: string): AudienceRules => ({
  v: 2,
  op: "and",
  rules: [{ field: "pipeline_stage", op: "in", pipelineId, ...(stageId ? { stageId } : {}) }],
});

async function both(pipelineId: string, stageId?: string) {
  const fake = createAudienceDb(predicateWorld());
  const deps = { prisma: fake.prisma, segments: { resolveContactWhere: jest.fn() } } as never;
  const listWhere = await buildContactWhere(WS, { pipelineId, stageId }, deps);
  const tree = stageRule(pipelineId, stageId);
  const lookups = await loadLookups(fake.prisma as never, WS, [tree]);
  const compiled = compileAudience(WS, tree, { now: NOW, tz: "UTC", lookups });
  return { list: evaluateContacts(fake.db, listWhere), audience: evaluateContacts(fake.db, compiled.where), issues: compiled.issues, listWhere, compiled };
}

describe("pipeline stage helper is shared by the list and audiences", () => {
  it("a stage: the list and the audience select the same set, including a closed card in a terminal stage", async () => {
    // a2's card in P1/won is closed (a won deal): "in Won" finds it in both.
    const won = await both("P1", "s1won");
    expect(won.list).toEqual(["a2"]);
    expect(won.audience).toEqual(won.list);
    const open = await both("P1", "s1new");
    expect(open.list).toEqual(["a1"]);
    expect(open.audience).toEqual(open.list);
  });

  it("a pipeline alone: open cards only, in both", async () => {
    const r = await both("P1");
    expect(r.list).toEqual(["a1"]);
    expect(r.audience).toEqual(r.list);
  });

  it("both emit the helper's exact predicate (workspace-scoped tickets)", async () => {
    const r = await both("P1", "s1won");
    expect((r.listWhere.AND as unknown[])).toContainEqual(pipelineStageWhere(WS, { pipelineId: "P1", stageId: "s1won" }, "in"));
    expect(pipelineStageWhere(WS, { pipelineId: "P1", stageId: "s1won" }, "in")).toEqual({
      tickets: { some: { workspaceId: WS, pipelineId: "P1", stageId: "s1won" } },
    });
    expect(pipelineStageWhere(WS, { pipelineId: "P1" }, "not_in")).toEqual({
      tickets: { none: { workspaceId: WS, pipelineId: "P1", closedAt: null } },
    });
  });

  it("an archived pipeline: nobody in the audience, with an issue", async () => {
    const r = await both("P2");
    expect(r.audience).toEqual([]);
    expect(r.issues).toEqual([{ path: [0], kind: "pipeline_archived" }]);
  });
});
