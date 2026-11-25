import { BadRequestException } from "@nestjs/common";
import { PipelinesService } from "./pipelines.service";
import { baseDraft, baseFixture, makePrisma } from "./test-prisma";

const withoutWork = () =>
  baseDraft({
    stages: baseDraft().stages.filter((s: any) => s.id !== "work").map((s: any, i: number) => ({ ...s, order: i })),
  });

describe("removing a stage that has cards", () => {
  it("moves cards to moveTo, logs stage_changed 'stage removed', resets enteredStageAt, deletes the stage, in one transaction", async () => {
    const f = baseFixture();
    const prisma = makePrisma(f);
    const svc = new PipelinesService(prisma);

    await svc.saveDraft("ws_1", "pl_1", { ...withoutWork(), removed: [{ stageId: "work", moveTo: "new" }] });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.tickets.every((t) => t.stageId === "new")).toBe(true);
    expect(f.tickets.every((t) => t.enteredStageAt instanceof Date)).toBe(true);
    expect(f.stages.find((s) => s.id === "work")).toBeUndefined();

    const acts = prisma.ticketActivity.createMany.mock.calls[0][0].data;
    expect(acts).toHaveLength(2);
    expect(acts[0]).toMatchObject({
      workspaceId: "ws_1", ticketId: "t1", kind: "stage_changed", note: "stage removed", fromStage: "work", toStage: "new",
    });
    // moves happen before the delete
    const names = prisma.calls.map(([n]: [string, unknown]) => n);
    expect(names.indexOf("ticket.updateMany")).toBeLessThan(names.indexOf("ticketStage.delete"));
  });

  it("is 400 pipelines.move_target_required without moveTo, and writes nothing", async () => {
    const f = baseFixture();
    const prisma = makePrisma(f);
    const svc = new PipelinesService(prisma);
    const err = await svc
      .saveDraft("ws_1", "pl_1", { ...withoutWork(), removed: [{ stageId: "work", moveTo: null }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe("pipelines.move_target_required");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(f.stages.find((s) => s.id === "work")).toBeDefined();
  });

  it("a card that arrives after validation (moveTo null) aborts the transaction instead of a dangling FK", async () => {
    const f = baseFixture();
    f.tickets = [];
    const prisma = makePrisma(f);
    const origFind = prisma.ticket.findMany;
    prisma.ticket.findMany = jest.fn(async (a: any) => {
      f.tickets.push({ id: "late", stageId: "work", pipelineId: "pl_1", lostReasonId: null });
      return origFind(a);
    });
    const svc = new PipelinesService(prisma);
    await expect(
      svc.saveDraft("ws_1", "pl_1", { ...withoutWork(), removed: [{ stageId: "work", moveTo: null }] }),
    ).rejects.toThrow("pipelines.move_target_required");
    expect(prisma.ticketStage.delete).not.toHaveBeenCalled();
  });
});

describe("lost reason in use", () => {
  it("dropping a referenced reason from the draft archives it (never deletes); an unreferenced one is deleted", async () => {
    const f = baseFixture();
    f.tickets.push({ id: "t3", stageId: "lost", pipelineId: "pl_1", lostReasonId: "r1", lostReason: "Price" });
    const prisma = makePrisma(f);
    const svc = new PipelinesService(prisma);
    await svc.saveDraft("ws_1", "pl_1", baseDraft({ lostReasons: [{ label: "New one", labelAr: "جديد", order: 0 }] }));
    const archive = prisma.lostReason.updateMany.mock.calls.find((c: any) => c[0].data.archivedAt);
    expect(archive[0].where.id.in).toEqual(["r1"]);
    expect(prisma.lostReason.deleteMany.mock.calls[0][0].where.id.in).toEqual(["r2"]);
    expect(prisma.lostReason.createMany.mock.calls[0][0].data[0]).toMatchObject({
      pipelineId: "pl_1", workspaceId: "ws_1", label: "New one",
    });
    // ticket keeps its snapshot label
    expect(f.tickets.find((t) => t.id === "t3")!.lostReason).toBe("Price");
  });
});
