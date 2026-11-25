import { NotFoundException } from "@nestjs/common";
import { ContactsService } from "./contacts.service";
import { SegmentsService } from "../segments/segments.service";

/**
 * Origin-aware segment resolution (C1). A manual group's `filter` is inert
 * ("{}"), which buildWhere resolves to the ENTIRE workspace — so
 * `GET /contacts?segmentId=<manual group>` used to list every contact under the
 * group's name, with the bulk bar's destructive actions attached.
 */
describe("ContactsService.list — segment resolution by origin", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    name: "Sara",
    phone: null,
    industry: "retail",
    lifecycle: "lead",
    source: "wa",
    value: null,
    lastSeen: "2m",
    tags: "[]",
    convs: 0,
    ...over,
  });

  let prisma: {
    contact: { findMany: jest.Mock };
    segment: { findFirst: jest.Mock };
  };
  let svc: ContactsService;

  beforeEach(() => {
    prisma = {
      contact: { findMany: jest.fn().mockResolvedValue([row()]) },
      segment: { findFirst: jest.fn() },
    };
    // Real SegmentsService over the mocked prisma: the branch under test is the
    // resolution contract shared with any future audience consumer.
    svc = new ContactsService(prisma as never, new SegmentsService(prisma as never));
  });

  const whereOf = () => prisma.contact.findMany.mock.calls[0][0].where;

  it("resolves a MANUAL group by membership, never by its inert filter", async () => {
    prisma.segment.findFirst.mockResolvedValue({ id: "s1", origin: "manual", filter: "{}" });
    await svc.list("ws1", { segmentId: "s1" });
    expect(whereOf()).toEqual({
      workspaceId: "ws1",
      segmentMembers: { some: { segmentId: "s1" } },
    });
  });

  it("resolves an HJZ segment by membership too", async () => {
    prisma.segment.findFirst.mockResolvedValue({
      id: "s9",
      origin: "hjz",
      // Even a non-empty hjz filter is not locally evaluable — membership wins.
      filter: JSON.stringify({ lifecycle: ["customer"] }),
    });
    await svc.list("ws1", { segmentId: "s9" });
    expect(whereOf()).toEqual({
      workspaceId: "ws1",
      segmentMembers: { some: { segmentId: "s9" } },
    });
  });

  it("still resolves a CRM segment through its saved filter", async () => {
    prisma.segment.findFirst.mockResolvedValue({
      id: "s2",
      origin: "crm",
      filter: JSON.stringify({ lifecycle: ["lead"], tagsAny: ["VIP"] }),
    });
    await svc.list("ws1", { segmentId: "s2" });
    const where = whereOf();
    expect(where.segmentMembers).toBeUndefined();
    expect(where.lifecycle).toEqual({ in: ["lead"] });
    expect(where.workspaceId).toBe("ws1");
  });

  it("resolves a stage-driven CRM segment to a ticket-stage predicate", async () => {
    prisma.segment.findFirst.mockResolvedValue({
      id: "s3",
      origin: "crm",
      filter: JSON.stringify({ stageAny: ["lost"] }),
    });
    await svc.list("ws1", { segmentId: "s3" });
    expect(whereOf()).toEqual({
      workspaceId: "ws1",
      tickets: { some: { stage: { key: { in: ["lost"] } } } },
    });
  });

  it("lists the whole workspace when no segmentId is given", async () => {
    await svc.list("ws1");
    expect(whereOf()).toEqual({ workspaceId: "ws1" });
    expect(prisma.segment.findFirst).not.toHaveBeenCalled();
  });

  it("404s on an unknown/foreign segmentId instead of falling back to everyone", async () => {
    prisma.segment.findFirst.mockResolvedValue(null);
    await expect(svc.list("ws1", { segmentId: "foreign" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });
});

describe("ContactsService.search", () => {
  let prisma: { contact: { findMany: jest.Mock } };
  let svc: ContactsService;

  beforeEach(() => {
    prisma = { contact: { findMany: jest.fn().mockResolvedValue([]) } };
    svc = new ContactsService(prisma as never, new SegmentsService(prisma as never));
  });

  it("matches by name or phone, case-insensitive, scoped to the workspace", async () => {
    await svc.search("ws1", "sara");
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws1",
        OR: [
          { name: { contains: "sara", mode: "insensitive" } },
          { phone: { contains: "sara", mode: "insensitive" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  });

  it("shapes results the same way list() does", async () => {
    prisma.contact.findMany.mockResolvedValue([
      {
        id: "c1", name: "Sara", phone: null, industry: "retail", lifecycle: "lead",
        source: "wa", value: null, lastSeen: "2m", tags: "[]", convs: 0,
      },
    ]);
    const result = await svc.search("ws1", "sara");
    expect(result).toEqual([
      {
        id: "c1", name: "Sara", phone: "", industry: "retail", lifecycle: "lead",
        source: "wa", value: "—", lastSeen: "2m", tags: [], convs: 0,
      },
    ]);
  });
});

describe("ContactsService.listPage", () => {
  const row = (id: string) => ({
    id,
    name: `C${id}`,
    phone: null,
    industry: "retail",
    lifecycle: "lead",
    source: "wa",
    value: null,
    lastSeen: "2m",
    tags: "[]",
    convs: 0,
  });
  let prisma: { contact: { findMany: jest.Mock; count: jest.Mock }; segment: { findFirst: jest.Mock } };
  let svc: ContactsService;

  beforeEach(() => {
    prisma = {
      contact: { findMany: jest.fn().mockResolvedValue([row("1"), row("2")]), count: jest.fn().mockResolvedValue(120) },
      segment: { findFirst: jest.fn() },
    };
    svc = new ContactsService(prisma as never, new SegmentsService(prisma as never));
  });

  it("returns one page plus the total, newest first", async () => {
    const res = await svc.listPage("ws1", { page: 2, pageSize: 50 });
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: 50,
      take: 50,
    });
    expect(res).toMatchObject({ total: 120, page: 2, pageSize: 50, pageCount: 3 });
    expect(res.items.map((c) => c.id)).toEqual(["1", "2"]);
  });

  it("searches name and phone on the server, case-insensitively", async () => {
    await svc.listPage("ws1", { q: "  lina ", page: 1, pageSize: 25 });
    expect(prisma.contact.findMany.mock.calls[0][0].where).toEqual({
      AND: [
        { workspaceId: "ws1" },
        { OR: [{ name: { contains: "lina", mode: "insensitive" } }, { phone: { contains: "lina" } }] },
      ],
    });
    expect(prisma.contact.count.mock.calls[0][0].where).toEqual(prisma.contact.findMany.mock.calls[0][0].where);
  });

  it("narrows to a segment's members", async () => {
    prisma.segment.findFirst.mockResolvedValue({ id: "g1", origin: "manual", filter: "{}" });
    await svc.listPage("ws1", { segmentId: "g1", page: 1, pageSize: 25 });
    expect(prisma.contact.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: "ws1",
      segmentMembers: { some: { segmentId: "g1" } },
    });
  });

  it("clamps silly paging values", async () => {
    await svc.listPage("ws1", { page: -3, pageSize: 10_000 });
    expect(prisma.contact.findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 200 });
  });

  it("reports a page count of 1 for an empty result", async () => {
    prisma.contact.count.mockResolvedValue(0);
    prisma.contact.findMany.mockResolvedValue([]);
    expect((await svc.listPage("ws1", { page: 1, pageSize: 50 })).pageCount).toBe(1);
  });
});

describe("ContactsService.stats", () => {
  it("counts contacts, leads and customers for the header", async () => {
    const prisma = {
      contact: {
        groupBy: jest.fn().mockResolvedValue([
          { lifecycle: "lead", _count: { _all: 30 } },
          { lifecycle: "Customer", _count: { _all: 12 } },
          { lifecycle: "churned", _count: { _all: 6 } },
        ]),
      },
    };
    const svc = new ContactsService(prisma as never, new SegmentsService(prisma as never));
    expect(await svc.stats("ws1")).toEqual({ total: 48, leads: 30, customers: 12 });
    expect(prisma.contact.groupBy).toHaveBeenCalledWith({ by: ["lifecycle"], where: { workspaceId: "ws1" }, _count: { _all: true } });
  });
});
