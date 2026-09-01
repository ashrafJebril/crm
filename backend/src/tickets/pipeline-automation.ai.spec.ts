import { PipelineAutomationService } from "./pipeline-automation.service";

/**
 * The AI stage-move rules are the entire safety story for letting an agent
 * touch the sales board, so each one gets an explicit test. A regression here
 * is silent: tickets quietly land in the wrong column and nobody notices until
 * the pipeline stops matching reality.
 */
describe("PipelineAutomationService.onAiStageSuggestion", () => {
  const WS = "ws1";
  const CONTACT = "ct1";

  // order matters: new(0) -> discovery(1) -> quoted(2) -> payment(3) -> done(4, terminal+won)
  const stages = {
    new: { id: "s-new", key: "new", groupKey: "new", order: 0, isTerminal: false, isWon: false },
    discovery: { id: "s-disc", key: "discovery", groupKey: "discovery", order: 1, isTerminal: false, isWon: false },
    quoted: { id: "s-quo", key: "quoted", groupKey: "quoted", order: 2, isTerminal: false, isWon: false },
    payment: { id: "s-pay", key: "payment", groupKey: "payment", order: 3, isTerminal: false, isWon: false },
    won: { id: "s-won", key: "won", groupKey: "done", order: 4, isTerminal: true, isWon: true },
  };

  function makePrisma(currentStage: (typeof stages)[keyof typeof stages] | null) {
    const updates: unknown[] = [];
    const activities: any[] = [];
    return {
      updates,
      activities,
      ticket: {
        findFirst: jest.fn(async () =>
          currentStage
            ? { id: "t1", pipelineId: "p1", stageId: currentStage.id, stage: currentStage }
            : null,
        ),
        update: jest.fn((args: unknown) => {
          updates.push(args);
          return args;
        }),
      },
      ticketStage: {
        findFirst: jest.fn(async ({ where }: any) => {
          const found = Object.values(stages).find((s) => s.groupKey === where.groupKey);
          return found ?? null;
        }),
      },
      ticketActivity: {
        create: jest.fn((args: any) => {
          activities.push(args);
          return args;
        }),
      },
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    } as any;
  }

  function svc(prisma: any) {
    return new PipelineAutomationService(prisma, { createTicket: jest.fn() } as any);
  }

  it("advances a ticket forward when confidence is high", async () => {
    const prisma = makePrisma(stages.discovery);
    await svc(prisma).onAiStageSuggestion(WS, CONTACT, "quoted", 0.9, "price given");
    expect(prisma.updates).toHaveLength(1);
    expect((prisma.updates[0] as any).data.stageId).toBe(stages.quoted.id);
  });

  // A few bad auto-moves destroy trust in the board faster than no automation.
  it("ignores a suggestion below the confidence floor", async () => {
    const prisma = makePrisma(stages.discovery);
    await svc(prisma).onAiStageSuggestion(WS, CONTACT, "quoted", 0.5);
    expect(prisma.updates).toHaveLength(0);
  });

  it("ignores a non-numeric confidence rather than coercing it", async () => {
    const prisma = makePrisma(stages.discovery);
    await svc(prisma).onAiStageSuggestion(WS, CONTACT, "quoted", NaN);
    expect(prisma.updates).toHaveLength(0);
  });

  // A confused customer message must not be able to undo a real sale.
  it("REFUSES to move a ticket backwards", async () => {
    const prisma = makePrisma(stages.payment);
    await svc(prisma).onAiStageSuggestion(WS, CONTACT, "discovery", 0.99);
    expect(prisma.updates).toHaveLength(0);
  });

  it("refuses a sideways move to the same stage", async () => {
    const prisma = makePrisma(stages.quoted);
    await svc(prisma).onAiStageSuggestion(WS, CONTACT, "quoted", 0.99);
    expect(prisma.updates).toHaveLength(0);
  });

  // Won and lost are money outcomes; a person decides them.
  it("NEVER auto-closes into a won/terminal stage, even at full confidence", async () => {
    const prisma = makePrisma(stages.payment);
    await svc(prisma).onAiStageSuggestion(WS, CONTACT, "done", 1.0);
    expect(prisma.updates).toHaveLength(0);
  });

  it("does nothing when the contact has no open ticket", async () => {
    const prisma = makePrisma(null);
    await svc(prisma).onAiStageSuggestion(WS, CONTACT, "quoted", 0.95);
    expect(prisma.updates).toHaveLength(0);
  });

  it("ignores a stage group this pipeline does not have", async () => {
    const prisma = makePrisma(stages.new);
    await svc(prisma).onAiStageSuggestion(WS, CONTACT, "no-such-group", 0.95);
    expect(prisma.updates).toHaveLength(0);
  });

  // Attribution: the board history must show a human did NOT do this.
  it("writes an activity row with a null user and the reason", async () => {
    const prisma = makePrisma(stages.new);
    await svc(prisma).onAiStageSuggestion(WS, CONTACT, "quoted", 0.86, "keratin price quoted");
    expect(prisma.activities).toHaveLength(1);
    const data = prisma.activities[0].data;
    expect(data.kind).toBe("stage_changed");
    expect(data.fromStage).toBe("new");
    expect(data.toStage).toBe("quoted");
    expect(data.byUserId).toBeUndefined();
    expect(data.note).toContain("moved by AI");
    expect(data.note).toContain("86%");
    expect(data.note).toContain("keratin price quoted");
  });

  // Pipeline automation must never break the message path that triggered it.
  it("swallows a database failure instead of throwing", async () => {
    const prisma = makePrisma(stages.new);
    prisma.$transaction = jest.fn(async () => {
      throw new Error("connection lost");
    });
    await expect(
      svc(prisma).onAiStageSuggestion(WS, CONTACT, "quoted", 0.95),
    ).resolves.toBeUndefined();
  });
});
