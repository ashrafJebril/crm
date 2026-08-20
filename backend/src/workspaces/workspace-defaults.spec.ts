import {
  DEFAULT_STAGES,
  STARTER_SEGMENTS,
  seedWorkspaceDefaults,
  stageSegmentsFor,
} from "./workspace-defaults";

/**
 * Every workspace must come out of provisioning usable: a sales pipeline with
 * the six stages (the inbound-message automation resolves 'new'/'contacted' by
 * groupKey, so it silently does nothing without them) and the ten smart groups
 * the Contacts → Groups tab shows.
 */
describe("seedWorkspaceDefaults", () => {
  const build = (
    existing: { pipeline?: { id: string }; stageKeys?: string[]; segmentNames?: string[] } = {},
  ) => {
    const created = { stages: [] as string[], segments: [] as string[], pipelines: 0 };
    const db = {
      pipeline: {
        findFirst: jest.fn().mockResolvedValue(existing.pipeline ?? null),
        create: jest.fn().mockImplementation(() => {
          created.pipelines += 1;
          return Promise.resolve({ id: "pl-new" });
        }),
      },
      ticketStage: {
        findMany: jest
          .fn()
          .mockResolvedValue((existing.stageKeys ?? []).map((key) => ({ key }))),
        create: jest.fn().mockImplementation((args: { data: { key: string } }) => {
          created.stages.push(args.data.key);
          return Promise.resolve({});
        }),
      },
      segment: {
        findMany: jest
          .fn()
          .mockResolvedValue((existing.segmentNames ?? []).map((name) => ({ name }))),
        create: jest.fn().mockImplementation((args: { data: { name: string } }) => {
          created.segments.push(args.data.name);
          return Promise.resolve({});
        }),
      },
    };
    return { db, created };
  };

  it("creates the pipeline, six stages and ten smart groups for a fresh workspace", async () => {
    const { db, created } = build();
    const res = await seedWorkspaceDefaults(db as never, "ws1");

    expect(created.pipelines).toBe(1);
    expect(created.stages).toEqual([
      "new",
      "contacted",
      "interested",
      "waiting",
      "won",
      "lost",
    ]);
    expect(created.segments).toHaveLength(10);
    expect(res).toEqual({ pipelineId: "pl-new", stagesCreated: 6, segmentsCreated: 10 });
  });

  it("gives the automation the stage groupKeys it looks up", async () => {
    const { db } = build();
    await seedWorkspaceDefaults(db as never, "ws1");
    const groupKeys = db.ticketStage.create.mock.calls.map(
      (c: [{ data: { groupKey: string } }]) => c[0].data.groupKey,
    );
    expect(groupKeys).toContain("new");
    expect(groupKeys).toContain("contacted");
  });

  it("scopes every created row to the workspace", async () => {
    const { db } = build();
    await seedWorkspaceDefaults(db as never, "ws9");
    for (const call of [
      ...db.ticketStage.create.mock.calls,
      ...db.segment.create.mock.calls,
    ]) {
      expect((call[0] as { data: { workspaceId: string } }).data.workspaceId).toBe("ws9");
    }
  });

  it("is idempotent — a fully set-up workspace gets nothing new", async () => {
    const { db, created } = build({
      pipeline: { id: "pl-existing" },
      stageKeys: DEFAULT_STAGES.map((s) => s.key),
      segmentNames: [
        ...STARTER_SEGMENTS.map((s) => s.name),
        ...stageSegmentsFor(DEFAULT_STAGES).map((s) => s.name),
      ],
    });
    const res = await seedWorkspaceDefaults(db as never, "ws1");

    expect(created).toEqual({ stages: [], segments: [], pipelines: 0 });
    expect(res).toEqual({ pipelineId: "pl-existing", stagesCreated: 0, segmentsCreated: 0 });
  });

  it("fills only the gaps when a workspace is half set up", async () => {
    const { db, created } = build({
      pipeline: { id: "pl-existing" },
      stageKeys: ["new", "contacted"],
      segmentNames: ["Customers", "Won deals"],
    });
    await seedWorkspaceDefaults(db as never, "ws1");

    expect(created.stages).toEqual(["interested", "waiting", "won", "lost"]);
    expect(created.segments).not.toContain("Customers");
    expect(created.segments).not.toContain("Won deals");
    expect(created.segments).toHaveLength(8);
  });

  it("names terminal stages' groups as deal buckets and matches on stage key", () => {
    const groups = stageSegmentsFor(DEFAULT_STAGES);
    const won = groups.find((g) => g.filter.stageAny[0] === "won");
    const contacted = groups.find((g) => g.filter.stageAny[0] === "contacted");
    expect(won?.name).toBe("Won deals");
    expect(won?.nameAr).toBe("صفقات تم الفوز");
    expect(contacted?.name).toBe("Contacted");
  });
});
