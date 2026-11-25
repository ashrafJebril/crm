import { BadRequestException, NotFoundException } from "@nestjs/common";
import { buildContactWhere, parseContactFilter } from "./contact-filter";

describe("parseContactFilter", () => {
  it("parses comma arrays, booleans and fields JSON", () => {
    const f = parseContactFilter({
      q: " sara ",
      lifecycle: "lead,customer",
      tags: "VIP,Hot",
      tagMode: "all",
      ownerId: "none",
      optOut: "true",
      notALead: "false",
      fields: encodeURIComponent(JSON.stringify([{ defId: "d1", op: "eq", value: "x" }])),
    });
    expect(f).toEqual({
      q: "sara",
      lifecycle: ["lead", "customer"],
      tags: ["VIP", "Hot"],
      tagMode: "all",
      ownerId: "none",
      optOut: true,
      notALead: false,
      fields: [{ defId: "d1", op: "eq", value: "x" }],
    });
  });

  it("parses tags sent as a JSON array, so a tag may contain a comma", () => {
    expect(parseContactFilter({ tags: JSON.stringify(["Riyadh, KSA", "VIP"]) }).tags).toEqual(["Riyadh, KSA", "VIP"]);
    // Comma-separated stays supported for old links.
    expect(parseContactFilter({ tags: "Riyadh,VIP" }).tags).toEqual(["Riyadh", "VIP"]);
    // A JSON body may still send a real array.
    expect(parseContactFilter({ tags: ["a, b"] }).tags).toEqual(["a, b"]);
  });

  it.each([[{ tags: "[not json" }], [{ tags: '[1,2]' }]])("rejects malformed JSON tags %j with 400", (q) => {
    expect(() => parseContactFilter(q)).toThrow(BadRequestException);
  });

  it("accepts raw (already-decoded) JSON for fields", () => {
    expect(parseContactFilter({ fields: '[{"defId":"d1","op":"set"}]' }).fields).toEqual([
      { defId: "d1", op: "set" },
    ]);
  });

  it.each([
    [{ fields: "{not json" }],
    [{ fields: '{"a":1}' }],
    [{ fields: '[{"defId":"d1","op":"nope"}]' }],
    [{ optOut: "maybe" }],
    [{ tagMode: "some" }],
  ])("rejects invalid input %j with 400", (q) => {
    expect(() => parseContactFilter(q as never)).toThrow(BadRequestException);
  });

  it("empty input gives an empty filter", () => {
    expect(parseContactFilter({})).toEqual({});
  });
});

describe("buildContactWhere", () => {
  let prisma: { customFieldDef: { findMany: jest.Mock } };
  let segments: { resolveContactWhere: jest.Mock };
  const build = (f: never) => buildContactWhere("ws1", f, { prisma, segments } as never);
  const and = (w: { AND?: unknown }) => (w.AND ?? []) as Record<string, unknown>[];

  beforeEach(() => {
    prisma = { customFieldDef: { findMany: jest.fn().mockResolvedValue([]) } };
    segments = { resolveContactWhere: jest.fn() };
  });

  it("always scopes to the workspace", async () => {
    expect(await build({} as never)).toEqual({ workspaceId: "ws1" });
  });

  it("q searches name, phone and email", async () => {
    const w = await build({ q: "sa" } as never);
    expect(and(w)).toContainEqual({
      OR: [
        { name: { contains: "sa", mode: "insensitive" } },
        { phone: { contains: "sa" } },
        { email: { contains: "sa", mode: "insensitive" } },
      ],
    });
  });

  it("segmentId reuses SegmentsService.resolveContactWhere", async () => {
    segments.resolveContactWhere.mockResolvedValue({ workspaceId: "ws1", segmentMembers: { some: { segmentId: "s1" } } });
    const w = await build({ segmentId: "s1" } as never);
    expect(segments.resolveContactWhere).toHaveBeenCalledWith("ws1", "s1");
    expect(and(w)).toContainEqual({ workspaceId: "ws1", segmentMembers: { some: { segmentId: "s1" } } });
  });

  it("segment 404 propagates", async () => {
    segments.resolveContactWhere.mockRejectedValue(new NotFoundException());
    await expect(build({ segmentId: "x" } as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("lifecycle, optOut, notALead", async () => {
    const w = await build({ lifecycle: ["lead"], optOut: true, notALead: false } as never);
    expect(w).toMatchObject({ marketingOptOut: true, notALead: false });
    expect(w.AND).toContainEqual({ OR: [{ lifecycle: { equals: "lead", mode: "insensitive" } }] });
  });

  it("ownerId none means unassigned; an id matches exactly", async () => {
    expect(await build({ ownerId: "none" } as never)).toMatchObject({ ownerId: null });
    expect(await build({ ownerId: "u1" } as never)).toMatchObject({ ownerId: "u1" });
  });

  it("tags match the quoted JSON element so VIP != VIPER (any)", async () => {
    const w = await build({ tags: ["VIP", "Hot"] } as never);
    expect(and(w)).toContainEqual({
      OR: [{ tags: { contains: '"VIP"' } }, { tags: { contains: '"Hot"' } }],
    });
    // The VIPER row's raw text does not contain the quoted needle.
    expect(JSON.stringify(["VIPER"]).includes('"VIP"')).toBe(false);
  });

  it("tagMode all requires every tag", async () => {
    const w = await build({ tags: ["VIP", "Hot"], tagMode: "all" } as never);
    expect(and(w)).toContainEqual({ AND: [{ tags: { contains: '"VIP"' } }, { tags: { contains: '"Hot"' } }] });
  });

  it("tag names with quotes are JSON-escaped like storage", async () => {
    const w = await build({ tags: ['a"b'] } as never);
    expect(JSON.stringify(w)).toContain(JSON.stringify(JSON.stringify('a"b')).slice(1, -1));
  });

  it("pipelineId/stageId: a stage matches any card in it, open or closed; a pipeline alone matches open cards (SP-16 ruling 9)", async () => {
    const w = await build({ pipelineId: "p1", stageId: "st1" } as never);
    expect(and(w)).toContainEqual({ tickets: { some: { workspaceId: "ws1", pipelineId: "p1", stageId: "st1" } } });
    const w2 = await build({ pipelineId: "p1" } as never);
    expect(and(w2)).toContainEqual({ tickets: { some: { workspaceId: "ws1", pipelineId: "p1", closedAt: null } } });
  });

  it("custom fields go through fieldWhere with workspace-scoped defs", async () => {
    prisma.customFieldDef.findMany.mockResolvedValue([{ id: "d1", type: "text" }]);
    const w = await build({ fields: [{ defId: "d1", op: "contains", value: "x" }] } as never);
    expect(prisma.customFieldDef.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws1", id: { in: ["d1"] }, archivedAt: null },
      select: { id: true, type: true },
    });
    expect(and(w)).toContainEqual({
      fieldValues: { some: { defId: "d1", value: { string_contains: "x" } } },
    });
  });

  it("foreign/unknown/archived field def -> 404", async () => {
    prisma.customFieldDef.findMany.mockResolvedValue([]);
    await expect(build({ fields: [{ defId: "other-ws", op: "set" }] } as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("unsupported op for the type -> 400", async () => {
    prisma.customFieldDef.findMany.mockResolvedValue([{ id: "d1", type: "select" }]);
    await expect(build({ fields: [{ defId: "d1", op: "gt", value: "1" }] } as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
