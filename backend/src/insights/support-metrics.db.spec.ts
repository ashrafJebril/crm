/**
 * Runner 2 of 2 (ruling 12): the REAL support SQL over the fixture world in
 * Postgres equals the hand-written expectations (`insights-expected.ts`), the
 * same ones the TS oracle meets. Skipped unless INSIGHTS_TEST_DATABASE_URL
 * points at a migrated database (the rest of the suite stays DB-free, as in
 * `conversation-resolution.db.spec.ts`). The world is seeded into fresh
 * throwaway workspaces and deleted afterwards, so it is safe on a shared
 * database (Task 6 runs it against production).
 */
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import { CH, EMPTY_WORLD, INSIGHTS_WORLD, RANGE, U } from "./__fixtures__/insights-world";
import { ASSIGNED, EMPTY, OWNER, OWNER_JEDDAH_HEADLINE, SUPPORT_METRIC_TESTS, type SupportExpectation } from "./insights-expected";
import { InsightsService } from "./insights.service";
import type { Section, SupportInsights } from "./insights.dto";
import { seedInsightsWorld, type SeededWorld } from "./world-seed";

const url = process.env.INSIGHTS_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const NOW = new Date("2026-11-10T09:00:00Z");

function ok<T>(s: Section<T>): T {
  if (s.status !== "ok") throw new Error(`section ${s.status}`);
  return s.data;
}

/** The response with database ids mapped back to fixture ids. */
function asExpectation(res: SupportInsights, world: SeededWorld): SupportExpectation {
  return {
    headline: ok(res.headline),
    resolutionMix: ok(res.resolutionMix),
    peaks: ok(res.peaks),
    byNumber: ok(res.byNumber).map((r) => ({ ...r, channelId: world.toLogical(r.channelId) })),
    topicFriction: ok(res.topicFriction),
    team: ok(res.team).map((r) => ({ ...r, userId: world.toLogical(r.userId) })),
  };
}

d("support insights SQL against Postgres", () => {
  let prisma: PrismaService;
  let svc: InsightsService;
  let world: SeededWorld;
  let empty: SeededWorld;
  let owner: SupportExpectation;
  let assigned: SupportExpectation;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    svc = new InsightsService(prisma, new PermissionService(prisma));
    world = await seedInsightsWorld(prisma.raw, INSIGHTS_WORLD);
    empty = await seedInsightsWorld(prisma.raw, EMPTY_WORLD);
    owner = asExpectation(await svc.support(world.workspaceId, RANGE, { userId: world.id(U.owner) }, NOW), world);
    assigned = asExpectation(await svc.support(world.workspaceId, RANGE, { userId: world.id(U.assigned) }, NOW), world);
  }, 120_000);

  afterAll(async () => {
    await world?.cleanup();
    await empty?.cleanup();
    await prisma?.onModuleDestroy();
  });

  it.each(Object.entries(SUPPORT_METRIC_TESTS))("%s", (_name, pick) => {
    expect(pick(owner)).toEqual(pick(OWNER));
    expect(pick(assigned)).toEqual(pick(ASSIGNED));
  });

  it("support insights respect assigned visibility", () => {
    expect(assigned).toEqual(ASSIGNED);
  });

  it("rates and medians are null on empty input", async () => {
    const res = await svc.support(empty.workspaceId, RANGE, undefined, NOW);
    expect(asExpectation(res, empty)).toEqual(EMPTY);
  });

  it("the channel filter narrows every metric", async () => {
    const res = await svc.support(world.workspaceId, { ...RANGE, channelId: world.id(CH.b) }, { userId: world.id(U.owner) }, NOW);
    expect(ok(res.headline)).toEqual(OWNER_JEDDAH_HEADLINE);
    expect(ok(res.byNumber).map((r) => world.toLogical(r.channelId))).toEqual([CH.b]);
  });

  it("foreign channel id is 404", async () => {
    const foreign = await prisma.raw.channel.create({
      data: { workspaceId: empty.workspaceId, kind: "whatsapp", provider: "zernio", externalId: `${empty.workspaceId}-wa`, displayName: "B's number" },
    });
    const notFound = { response: { statusCode: 404, message: "insights.channel_not_found" } };
    await expect(svc.support(world.workspaceId, { ...RANGE, channelId: foreign.id }, undefined, NOW)).rejects.toMatchObject(notFound);
    await expect(svc.support(world.workspaceId, { ...RANGE, channelId: world.id(CH.ig) }, undefined, NOW)).rejects.toMatchObject(notFound);
  });
});
