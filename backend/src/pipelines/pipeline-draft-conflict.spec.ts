import { ConflictException } from "@nestjs/common";
import { PipelinesService } from "./pipelines.service";
import { baseDraft, baseFixture, makePrisma } from "./test-prisma";

describe("pipeline draft concurrent edits", () => {
  it("first save wins and bumps the version; the second from the same version gets 409 with the current pipeline", async () => {
    const f = baseFixture();
    const prisma = makePrisma(f);
    const svc = new PipelinesService(prisma);

    const first = await svc.saveDraft("ws_1", "pl_1", baseDraft({ name: "Sales A" }));
    expect(first.version).toBe(4);
    expect(f.pipeline.name).toBe("Sales A");

    const writesBefore = prisma.calls.length;
    const err = await svc.saveDraft("ws_1", "pl_1", baseDraft({ name: "Sales B" })).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      message: "pipelines.version_conflict",
      current: { id: "pl_1", version: 4, name: "Sales A" },
    });
    expect(f.pipeline.name).toBe("Sales A");
    // rejected before any write
    expect(
      prisma.calls.slice(writesBefore).some(([n]: [string, unknown]) => /update|create|delete/.test(n)),
    ).toBe(false);
  });

  it("a race lost inside the transaction (version guard matches 0 rows) is a 409, not a half-applied save", async () => {
    const f = baseFixture();
    const prisma = makePrisma(f);
    // Another save commits between our read and our guarded write.
    const orig = prisma.pipeline.updateMany;
    prisma.pipeline.updateMany = jest.fn(async (a: any) => {
      f.pipeline.version = 4;
      return orig(a);
    });
    const svc = new PipelinesService(prisma);
    await expect(svc.saveDraft("ws_1", "pl_1", baseDraft({ name: "X" }))).rejects.toBeInstanceOf(ConflictException);
    // the guarded update is the first write: nothing else ran
    expect(prisma.ticketStage.update).not.toHaveBeenCalled();
    expect(prisma.lostReason.createMany).not.toHaveBeenCalled();
  });
});
