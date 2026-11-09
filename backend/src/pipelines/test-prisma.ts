/** In-memory Prisma double for PipelinesService specs (not a runtime file). */
export interface PipeFixture {
  pipeline: any;
  stages: any[];
  tickets: any[];
  reasons: any[];
}

export function makePrisma(f: PipeFixture) {
  const calls: Array<[string, any]> = [];
  const rec = (name: string, fn: (a: any) => any) =>
    jest.fn(async (a: any) => {
      calls.push([name, a]);
      return fn(a);
    });
  const prisma: any = {
    calls,
    $transaction: jest.fn(async (cb: any) => cb(prisma)),
    pipeline: {
      findFirst: rec("pipeline.findFirst", () => ({
        ...f.pipeline,
        stages: f.stages.map((s) => ({ ...s, _count: { tickets: f.tickets.filter((t) => t.stageId === s.id).length } })),
        lostReasons: f.reasons.map((r) => ({ ...r, _count: { tickets: f.tickets.filter((t) => t.lostReasonId === r.id).length } })),
      })),
      findMany: rec("pipeline.findMany", () => [f.pipeline]),
      create: rec("pipeline.create", (a) => ({ id: "pl_new", ...a.data, stages: [] })),
      updateMany: rec("pipeline.updateMany", (a) => {
        if (a.where.version !== undefined && a.where.version !== f.pipeline.version) return { count: 0 };
        for (const [k, v] of Object.entries(a.data)) {
          if (k === "version") continue;
          f.pipeline[k] = v;
        }
        if ((a.data as any).version?.increment) f.pipeline.version += (a.data as any).version.increment;
        return { count: 1 };
      }),
    },
    ticketStage: {
      create: rec("ticketStage.create", (a) => {
        const s = { id: `st_${f.stages.length + 1}`, ...a.data };
        f.stages.push(s);
        return s;
      }),
      update: rec("ticketStage.update", (a) => {
        Object.assign(f.stages.find((s) => s.id === a.where.id), a.data);
        return {};
      }),
      delete: rec("ticketStage.delete", (a) => {
        if (f.tickets.some((t) => t.stageId === a.where.id)) throw new Error("FK violation");
        f.stages = f.stages.filter((s) => s.id !== a.where.id);
        return {};
      }),
    },
    ticket: {
      findMany: rec("ticket.findMany", (a) => f.tickets.filter((t) => t.stageId === a.where.stageId)),
      updateMany: rec("ticket.updateMany", (a) => {
        const hit = f.tickets.filter((t) => t.stageId === a.where.stageId);
        hit.forEach((t) => Object.assign(t, a.data));
        return { count: hit.length };
      }),
    },
    ticketActivity: {
      createMany: rec("ticketActivity.createMany", (a) => ({ count: a.data.length })),
    },
    lostReason: {
      findMany: rec("lostReason.findMany", (a) =>
        f.reasons
          .filter((r) => (a.where?.archivedAt === null ? r.archivedAt == null : true))
          .sort((x, y) => x.order - y.order),
      ),
      count: rec("lostReason.count", () => f.reasons.length),
      createMany: rec("lostReason.createMany", (a) => ({ count: a.data.length })),
      update: rec("lostReason.update", () => ({})),
      updateMany: rec("lostReason.updateMany", () => ({ count: 1 })),
      deleteMany: rec("lostReason.deleteMany", () => ({ count: 1 })),
    },
  };
  return prisma;
}

export const baseFixture = (): PipeFixture => ({
  pipeline: {
    id: "pl_1", workspaceId: "ws_1", key: "sales", name: "Sales", nameAr: "المبيعات", isDefault: false,
    version: 3, archivedAt: null, staleDays: null, agentCanMove: true, assignsConversations: false, kind: "deals",
  },
  stages: [
    { id: "new", key: "new", label: "New", labelAr: "جديد", color: "info", order: 0, isTerminal: false, isWon: false, slaMinutes: null, pipelineId: "pl_1", groupKey: "new" },
    { id: "work", key: "work", label: "Work", labelAr: "عمل", color: "warn", order: 1, isTerminal: false, isWon: false, slaMinutes: null, pipelineId: "pl_1", groupKey: "x" },
    { id: "won", key: "won", label: "Won", labelAr: "ربح", color: "ok", order: 2, isTerminal: true, isWon: true, slaMinutes: null, pipelineId: "pl_1", groupKey: "done" },
    { id: "lost", key: "lost", label: "Lost", labelAr: "خسارة", color: "bad", order: 3, isTerminal: true, isWon: false, slaMinutes: null, pipelineId: "pl_1", groupKey: "done" },
  ],
  tickets: [
    { id: "t1", stageId: "work", pipelineId: "pl_1", lostReasonId: null },
    { id: "t2", stageId: "work", pipelineId: "pl_1", lostReasonId: null },
  ],
  reasons: [
    { id: "r1", pipelineId: "pl_1", label: "Price", labelAr: "السعر", order: 0, archivedAt: null },
    { id: "r2", pipelineId: "pl_1", label: "Other", labelAr: "أخرى", order: 1, archivedAt: null },
  ],
});

export const baseDraft = (over: Record<string, unknown> = {}): any => ({
  version: 3,
  name: "Sales", nameAr: "المبيعات", staleDays: null, agentCanMove: true, assignsConversations: false,
  stages: [
    { id: "new", label: "New", labelAr: "جديد", color: "info", order: 0, isWon: false, isTerminal: false },
    { id: "work", label: "Work", labelAr: "عمل", color: "warn", order: 1, isWon: false, isTerminal: false },
    { id: "won", label: "Won", labelAr: "ربح", color: "ok", order: 2, isWon: true, isTerminal: true },
    { id: "lost", label: "Lost", labelAr: "خسارة", color: "bad", order: 3, isWon: false, isTerminal: true },
  ],
  removed: [] as Array<{ stageId: string; moveTo?: string | null }>,
  lostReasons: [
    { id: "r1", label: "Price", labelAr: "السعر", order: 0 },
    { id: "r2", label: "Other", labelAr: "أخرى", order: 1 },
  ],
  ...over,
});
