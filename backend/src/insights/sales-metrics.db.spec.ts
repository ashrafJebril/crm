/**
 * Runner 2 of 2 for the sales metrics (ruling 12): the REAL sales SQL over
 * the fixture world in Postgres equals `insights-expected.ts`. Skipped unless
 * INSIGHTS_TEST_DATABASE_URL points at a migrated database. Seeds throwaway
 * workspaces and deletes them afterwards (safe on a shared database).
 */
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import { EMPTY_SALES_WORLD, INSIGHTS_WORLD, SALES_NOW, SALES_RANGE, U } from "./__fixtures__/insights-world";
import { SALES_ASSIGNED, SALES_EMPTY, SALES_METRIC_TESTS, SALES_OWNER, SALES_WEEKLY_EN, type SalesExpectation } from "./insights-expected";
import { InsightsService } from "./insights.service";
import type { SalesInsights, Section } from "./insights.dto";
import { seedInsightsWorld, type SeededWorld } from "./world-seed";

const url = process.env.INSIGHTS_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

function ok<T>(s: Section<T>): T {
  if (s.status !== "ok") throw new Error(`section ${s.status}`);
  return s.data;
}

/** The response with database ids mapped back to fixture ids. */
function asExpectation(res: SalesInsights, world: SeededWorld): SalesExpectation {
  return {
    headline: ok(res.headline),
    distribution: ok(res.distribution),
    weekly: ok(res.weekly),
    sources: ok(res.sources).map((r) => ({
      ...r,
      key: r.kind === "ad" ? (world.toLogical(r.key) as string) : r.key,
      ...(r.id !== undefined ? { id: world.toLogical(r.id) as string } : {}),
    })) as SalesExpectation["sources"],
    funnel: ok(res.funnel).map((r) => ({ ...r, stageId: world.toLogical(r.stageId) as string })),
    lostReasons: ok(res.lostReasons).map((r) => ({ ...r, reasonId: world.toLogical(r.reasonId) })),
    reps: ok(res.reps).map((r) => ({ ...r, userId: world.toLogical(r.userId) })),
  };
}

d("sales insights SQL against Postgres", () => {
  let prisma: PrismaService;
  let svc: InsightsService;
  let world: SeededWorld;
  let empty: SeededWorld;
  let owner: SalesExpectation;
  let assigned: SalesExpectation;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    svc = new InsightsService(prisma, new PermissionService(prisma));
    world = await seedInsightsWorld(prisma.raw, INSIGHTS_WORLD);
    empty = await seedInsightsWorld(prisma.raw, EMPTY_SALES_WORLD);
    owner = asExpectation(await svc.sales(world.workspaceId, SALES_RANGE, { userId: world.id(U.owner) }, SALES_NOW), world);
    assigned = asExpectation(await svc.sales(world.workspaceId, SALES_RANGE, { userId: world.id(U.assigned) }, SALES_NOW), world);
  }, 120_000);

  afterAll(async () => {
    await world?.cleanup();
    await empty?.cleanup();
    await prisma?.onModuleDestroy();
  });

  it.each(Object.entries(SALES_METRIC_TESTS))("%s", (_name, pick) => {
    expect(pick(owner)).toEqual(pick(SALES_OWNER));
    expect(pick(assigned)).toEqual(pick(SALES_ASSIGNED));
  });

  it("sales waiting ignores hidden threads", () => {
    expect(owner.headline.waiting).toBe(3);
    expect(assigned.headline.waiting).toBe(0);
  });

  it("default pipeline is the first leads pipeline", async () => {
    const res = await svc.sales(world.workspaceId, SALES_RANGE, undefined, SALES_NOW);
    expect(world.toLogical(res.pipeline.id)).toBe("pl-leads");
  });

  it("weekly trend buckets by workspace-local week (English: Monday weeks)", async () => {
    await prisma.raw.workspace.update({ where: { id: world.workspaceId }, data: { lang: "en" } });
    try {
      const res = await svc.sales(world.workspaceId, SALES_RANGE, undefined, SALES_NOW);
      expect(ok(res.weekly)).toEqual(SALES_WEEKLY_EN);
    } finally {
      await prisma.raw.workspace.update({ where: { id: world.workspaceId }, data: { lang: "ar" } });
    }
  });

  it("sales rates and medians are null on empty input", async () => {
    const res = await svc.sales(empty.workspaceId, SALES_RANGE, undefined, SALES_NOW);
    expect(asExpectation(res, empty)).toEqual(SALES_EMPTY);
  });

  it("foreign pipeline id is 404", async () => {
    const notFound = { response: { statusCode: 404, message: "insights.pipeline_not_found" } };
    await expect(svc.sales(world.workspaceId, { ...SALES_RANGE, pipelineId: empty.id("pl-leads") }, undefined, SALES_NOW)).rejects.toMatchObject(
      notFound,
    );
  });

  it("ticket sections are forbidden without tickets.view", async () => {
    const role = await prisma.raw.role.create({
      data: { workspaceId: world.workspaceId, key: null, name: `reports-only ${world.workspaceId}`, nameAr: "تقارير", permissions: { reports: ["view"] } },
    });
    const user = await prisma.raw.user.create({
      data: { email: `${world.workspaceId}+reports@insights.invalid`, name: "Reports", initials: "RE", color: "150" },
    });
    try {
      await prisma.raw.workspaceMember.create({ data: { userId: user.id, workspaceId: world.workspaceId, role: "custom", roleId: role.id } });
      const res = await svc.sales(world.workspaceId, SALES_RANGE, { userId: user.id }, SALES_NOW);
      expect(res.headline).toEqual({ status: "forbidden" });
      expect(res.reps).toEqual({ status: "forbidden" });
    } finally {
      await prisma.raw.workspaceMember.deleteMany({ where: { userId: user.id } });
      await prisma.raw.user.delete({ where: { id: user.id } });
    }
  });
});
