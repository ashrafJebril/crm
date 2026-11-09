import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PipelinesService, DEFAULT_LOST_REASONS } from "./pipelines.service";
import { baseDraft, baseFixture, makePrisma } from "./test-prisma";

describe("PipelinesService", () => {
  it("list hides archived pipelines unless includeArchived", async () => {
    const prisma = makePrisma(baseFixture());
    const svc = new PipelinesService(prisma);
    await svc.list("ws_1", false);
    expect(prisma.pipeline.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_1", archivedAt: null });
    await svc.list("ws_1", true);
    expect(prisma.pipeline.findMany.mock.calls[1][0].where).toEqual({ workspaceId: "ws_1" });
  });

  it("create makes a bilingual New / In progress / Won / Lost pipeline with a unique key", async () => {
    const prisma = makePrisma(baseFixture());
    prisma.pipeline.findMany = jest.fn(async () => [{ key: "renewals" }]);
    const svc = new PipelinesService(prisma);
    await svc.create("ws_1", { name: "Renewals", nameAr: "التجديدات", kind: "deals" });
    const data = prisma.pipeline.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ workspaceId: "ws_1", key: "renewals_2", name: "Renewals", kind: "deals", isDefault: false });
    const stages = data.stages.create;
    expect(stages.map((s: any) => s.label)).toEqual(["New", "In progress", "Won", "Lost"]);
    expect(stages.every((s: any) => s.labelAr && s.workspaceId === "ws_1")).toBe(true);
    expect(stages.map((s: any) => [s.order, s.isTerminal, s.isWon])).toEqual([
      [0, false, false], [1, false, false], [2, true, true], [3, true, false],
    ]);
    expect(data.lostReasons.create.length).toBeGreaterThanOrEqual(1);
  });

  it("the default pipeline cannot be archived", async () => {
    const f = baseFixture();
    f.pipeline.isDefault = true;
    const svc = new PipelinesService(makePrisma(f));
    const err = await svc.archive("ws_1", "pl_1").catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe("pipelines.cannot_archive_default");
  });

  it("the pipeline keyed support cannot be archived", async () => {
    const f = baseFixture();
    f.pipeline.key = "support";
    const svc = new PipelinesService(makePrisma(f));
    const err = await svc.archive("ws_1", "pl_1").catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe("pipelines.cannot_archive_support");
    expect(f.pipeline.archivedAt).toBeNull();
  });

  it("archive sets archivedAt, unarchive clears it, both bump the version", async () => {
    const f = baseFixture();
    const prisma = makePrisma(f);
    const svc = new PipelinesService(prisma);
    await svc.archive("ws_1", "pl_1");
    expect(f.pipeline.archivedAt).toBeInstanceOf(Date);
    await svc.unarchive("ws_1", "pl_1");
    expect(f.pipeline.archivedAt).toBeNull();
    expect(f.pipeline.version).toBe(5);
  });

  it("lost-reasons returns non-archived reasons ordered by order, 404 for a foreign pipeline", async () => {
    const f = baseFixture();
    const prisma = makePrisma(f);
    const svc = new PipelinesService(prisma);
    await svc.lostReasons("ws_1", "pl_1");
    expect(prisma.lostReason.findMany.mock.calls[0][0]).toMatchObject({
      where: { pipelineId: "pl_1", workspaceId: "ws_1", archivedAt: null },
      orderBy: { order: "asc" },
    });
    prisma.pipeline.findFirst = jest.fn(async () => null);
    await expect(svc.lostReasons("ws_1", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("create reserves the support and sales slugs and never makes a support-kind pipeline", async () => {
    const prisma = makePrisma(baseFixture());
    prisma.pipeline.findMany = jest.fn(async () => []);
    const svc = new PipelinesService(prisma);
    await svc.create("ws_1", { name: "Support", nameAr: "الدعم", kind: "support" as any });
    const data = prisma.pipeline.create.mock.calls[0][0].data;
    expect(data.key).toBe("support_2");
    expect(data.kind).toBe("deals");
    await svc.create("ws_1", { name: "Sales", nameAr: "x", kind: "leads" });
    expect(prisma.pipeline.create.mock.calls[1][0].data).toMatchObject({ key: "sales_2", kind: "leads" });
  });

  it("saveDraft on an archived pipeline is 400 pipelines.archived", async () => {
    const f = baseFixture();
    f.pipeline.archivedAt = new Date();
    const svc = new PipelinesService(makePrisma(f));
    const err = await svc.saveDraft("ws_1", "pl_1", baseDraft()).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe("pipelines.archived");
  });

  it("lost-reasons lazily seeds the defaults once when the pipeline has none", async () => {
    const f = baseFixture();
    f.reasons = [];
    const prisma = makePrisma(f);
    prisma.lostReason.createMany = jest.fn(async (a: any) => {
      f.reasons = a.data.map((r: any, i: number) => ({ id: `n${i}`, archivedAt: null, ...r }));
      return { count: a.data.length };
    });
    const svc = new PipelinesService(prisma);
    const out = await svc.lostReasons("ws_1", "pl_1");
    expect(out.length).toBe(DEFAULT_LOST_REASONS.length);
    await svc.lostReasons("ws_1", "pl_1");
    expect(prisma.lostReason.createMany).toHaveBeenCalledTimes(1);
  });
});
