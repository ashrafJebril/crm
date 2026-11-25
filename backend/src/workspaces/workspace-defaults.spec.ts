import {
  DEFAULT_STAGES,
  STARTER_SEGMENTS,
  seedWorkspaceDefaults,
  stageSegmentsFor,
  WORKSPACE_TX_OPTIONS,
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
        createMany: jest.fn().mockImplementation((args: { data: Array<{ key: string }> }) => {
          created.stages.push(...args.data.map((d) => d.key));
          return Promise.resolve({});
        }),
      },
      lostReason: {
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: 5 }),
      },
      segment: {
        findMany: jest
          .fn()
          .mockResolvedValue((existing.segmentNames ?? []).map((name) => ({ name }))),
        createMany: jest.fn().mockImplementation((args: { data: Array<{ name: string }> }) => {
          created.segments.push(...args.data.map((d) => d.name));
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

  it("produces the full default record set (counts) in bulk inserts", async () => {
    const { db } = build();
    await seedWorkspaceDefaults(db as never, "ws1");
    expect(db.pipeline.create).toHaveBeenCalledTimes(1);
    expect(db.ticketStage.createMany.mock.calls[0][0].data).toHaveLength(6);
    expect(db.lostReason.createMany.mock.calls[0][0].data).toHaveLength(5);
    expect(db.segment.createMany.mock.calls[0][0].data).toHaveLength(10);
  });

  it("transaction options carry the raised timeout", () => {
    expect(WORKSPACE_TX_OPTIONS.timeout).toBeGreaterThanOrEqual(30_000);
    expect(WORKSPACE_TX_OPTIONS.maxWait).toBeGreaterThanOrEqual(10_000);
  });

  it("gives the automation the stage groupKeys it looks up", async () => {
    const { db } = build();
    await seedWorkspaceDefaults(db as never, "ws1");
    const groupKeys = db.ticketStage.createMany.mock.calls.flatMap(
      (c: [{ data: Array<{ groupKey: string }> }]) => c[0].data.map((d) => d.groupKey),
    );
    expect(groupKeys).toContain("new");
    expect(groupKeys).toContain("contacted");
  });

  it("scopes every created row to the workspace", async () => {
    const { db } = build();
    await seedWorkspaceDefaults(db as never, "ws9");
    const rows = [
      ...db.ticketStage.createMany.mock.calls,
      ...db.segment.createMany.mock.calls,
    ].flatMap((c) => (c[0] as { data: Array<{ workspaceId: string }> }).data);
    expect(rows).toHaveLength(16);
    for (const row of rows) expect(row.workspaceId).toBe("ws9");
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

  it("seeds default lost reasons for the sales pipeline, and not when some exist", async () => {
    const { db } = build();
    await seedWorkspaceDefaults(db as never, "ws1");
    const arg = db.lostReason.createMany.mock.calls[0][0];
    expect(arg.data.length).toBeGreaterThanOrEqual(1);
    expect(arg.data[0]).toMatchObject({ workspaceId: "ws1", pipelineId: "pl-new" });
    const again = build();
    again.db.lostReason.count.mockResolvedValue(3);
    await seedWorkspaceDefaults(again.db as never, "ws1");
    expect(again.db.lostReason.createMany).not.toHaveBeenCalled();
  });
});
