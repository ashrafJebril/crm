import { SLA_DUE_SOON_MS, slaDueAtFor, slaState } from "./ticket-sla";
import { TicketsService } from "./tickets.service";
import { makeFakePrisma } from "../channels/test-prisma";
import { PipelinesService } from "../pipelines/pipelines.service";
import { baseDraft, baseFixture, makePrisma as makePipePrisma } from "../pipelines/test-prisma";

const MIN = 60_000;

describe("slaDueAtFor (TS mirror of the trigger)", () => {
  const t = new Date("2026-11-16T08:00:00.000Z");
  it("entry + slaMinutes; null for no SLA, a terminal stage or no stage", () => {
    expect(slaDueAtFor({ slaMinutes: 120, isTerminal: false }, t)).toEqual(new Date(t.getTime() + 120 * MIN));
    expect(slaDueAtFor({ slaMinutes: null, isTerminal: false }, t)).toBeNull();
    expect(slaDueAtFor({ slaMinutes: 60, isTerminal: true }, t)).toBeNull();
    expect(slaDueAtFor(undefined, t)).toBeNull();
    expect(slaDueAtFor({ slaMinutes: 0, isTerminal: false }, t)).toEqual(t);
  });
});

describe("slaState", () => {
  const now = new Date("2026-11-16T12:00:00.000Z");
  const at = (ms: number) => new Date(now.getTime() + ms);
  it("finished / none / breached / due_soon / on_track", () => {
    expect(slaState({ slaDueAt: at(-MIN), stageIsTerminal: true }, now)).toBe("finished");
    expect(slaState({ slaDueAt: null, stageIsTerminal: false }, now)).toBe("none");
    expect(slaState({ slaDueAt: at(-1), stageIsTerminal: false }, now)).toBe("breached");
    expect(slaState({ slaDueAt: at(0), stageIsTerminal: false }, now)).toBe("due_soon");
    expect(slaState({ slaDueAt: at(SLA_DUE_SOON_MS), stageIsTerminal: false }, now)).toBe("due_soon");
    expect(slaState({ slaDueAt: at(SLA_DUE_SOON_MS + 1), stageIsTerminal: false }, now)).toBe("on_track");
    expect(slaState({ slaDueAt: at(-MIN).toISOString(), stageIsTerminal: false }, now)).toBe("breached");
    expect(SLA_DUE_SOON_MS).toBe(24 * 60 * MIN);
  });
});

/** A support pipeline over the in-memory double, whose ticket writes run the trigger mirror. */
function supportWorld() {
  const WS = "ws1";
  const prisma = makeFakePrisma({
    workspace: [{ id: WS, timezone: "Asia/Riyadh" }],
    pipeline: [{ id: "pl", workspaceId: WS, kind: "support", archivedAt: null, agentCanMove: true, assignsConversations: false }],
    ticketStage: [
      { id: "s-open", workspaceId: WS, pipelineId: "pl", key: "open", order: 0, isTerminal: false, isWon: false, slaMinutes: 120 },
      { id: "s-prog", workspaceId: WS, pipelineId: "pl", key: "in_progress", order: 1, isTerminal: false, isWon: false, slaMinutes: 1440 },
      { id: "s-wait", workspaceId: WS, pipelineId: "pl", key: "pending_customer", order: 2, isTerminal: false, isWon: false, slaMinutes: null },
      { id: "s-done", workspaceId: WS, pipelineId: "pl", key: "resolved", order: 3, isTerminal: true, isWon: true, slaMinutes: 60 },
    ],
    contact: [{ id: "ct", workspaceId: WS, name: "Lina", lifecycle: "customer" }],
    workspaceMember: [{ id: "wm", workspaceId: WS, userId: "u2", role: "agent" }],
  });
  const svc = new TicketsService(prisma, { emitToWorkspace: jest.fn() } as never);
  return { WS, prisma, svc };
}

describe("slaDueAt recalculated on stage change", () => {
  const T = new Date("2026-11-16T08:00:00.000Z");
  const plus = (d: Date, min: number) => new Date(d.getTime() + min * MIN);

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "setTimeout", "setInterval"] });
    jest.setSystemTime(T);
  });
  afterEach(() => jest.useRealTimers());

  it("create, move, no-SLA stage, terminal stage, reopen, and non-stage updates", async () => {
    const { WS, prisma, svc } = supportWorld();
    const row = () => prisma.db.ticket[0];

    // Created in a 120-minute stage at T.
    const t = await svc.createTicket(WS, { pipelineId: "pl", stageId: "s-open", contactId: "ct", title: "AC broken" });
    expect(row().slaDueAt).toEqual(plus(T, 120));

    // Moved to a 1440-minute stage at T2.
    const T2 = plus(T, 30);
    jest.setSystemTime(T2);
    await svc.moveTicket(WS, t.id, { stageId: "s-prog" });
    expect(row().slaDueAt).toEqual(plus(T2, 1440));

    // A title / owner / priority update leaves it alone.
    jest.setSystemTime(plus(T2, 5));
    await svc.updateTicket(WS, t.id, { title: "AC still broken", ownerId: "u2", priority: "urgent" });
    expect(row().slaDueAt).toEqual(plus(T2, 1440));
    expect(row().priority).toBe("urgent");

    // A stage without slaMinutes clears it.
    await svc.moveTicket(WS, t.id, { stageId: "s-wait" });
    expect(row().slaDueAt).toBeNull();

    // Back into an SLA stage, then a terminal stage (which has slaMinutes, still null).
    await svc.moveTicket(WS, t.id, { stageId: "s-open" });
    expect(row().slaDueAt).toEqual(plus(plus(T2, 5), 120));
    await svc.moveTicket(WS, t.id, { stageId: "s-done" });
    expect(row().slaDueAt).toBeNull();

    // Reopen at T3 into the stage it closed from: the clock restarts.
    const T3 = plus(T, 600);
    jest.setSystemTime(T3);
    await svc.reopenTicket(WS, t.id);
    expect(row().stageId).toBe("s-open");
    expect(row().slaDueAt).toEqual(plus(T3, 120));
  });

  it("a stage delete that moves cards (PipelinesService) sets the due date of the target stage", async () => {
    const f = baseFixture();
    f.stages.find((s) => s.id === "new")!.slaMinutes = 60;
    const prisma = makePipePrisma(f);
    // The draft keeps the target stage's SLA (saveDraft writes slaMinutes from it).
    const without = baseDraft({
      stages: baseDraft()
        .stages.filter((s: any) => s.id !== "work")
        .map((s: any, i: number) => ({ ...s, order: i, ...(s.id === "new" ? { slaMinutes: 60 } : {}) })),
      removed: [{ stageId: "work", moveTo: "new" }],
    });
    await new PipelinesService(prisma).saveDraft("ws_1", "pl_1", without);
    for (const t of f.tickets) {
      expect(t.stageId).toBe("new");
      expect(t.slaDueAt).toEqual(new Date(t.enteredStageAt.getTime() + 60 * MIN));
    }
  });
});
