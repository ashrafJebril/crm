import { SegmentsService } from "./segments.service";

describe("SegmentsService.buildWhere", () => {
  const svc = new SegmentsService({} as never);

  it("matches lifecycle case-insensitively (legacy 'Lead' rows still count)", () => {
    const where = svc.buildWhere("ws1", { lifecycle: ["lead", "Customer"] });
    expect(where.workspaceId).toBe("ws1");
    expect(where.lifecycle).toBeUndefined();
    expect(where.AND).toEqual([
      {
        OR: [
          { lifecycle: { equals: "lead", mode: "insensitive" } },
          { lifecycle: { equals: "Customer", mode: "insensitive" } },
        ],
      },
    ]);
  });

  it("keeps tag clauses alongside the lifecycle clause", () => {
    const where = svc.buildWhere("ws1", { lifecycle: ["lead"], tagsAll: ["VIP"] });
    expect(where.AND).toEqual([
      { OR: [{ lifecycle: { equals: "lead", mode: "insensitive" } }] },
      { tags: { contains: '"VIP"' } },
    ]);
  });

  it("adds no lifecycle clause for an empty list", () => {
    expect(svc.buildWhere("ws1", { lifecycle: [] })).toEqual({ workspaceId: "ws1" });
  });
});
