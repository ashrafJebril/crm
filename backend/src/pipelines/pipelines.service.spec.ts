import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PipelinesService } from "./pipelines.service";
import { baseFixture, makePrisma } from "./test-prisma";

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
});
