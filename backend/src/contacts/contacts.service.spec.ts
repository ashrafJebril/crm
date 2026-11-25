import { BadRequestException, NotFoundException } from "@nestjs/common";
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
    expect(where.AND).toContainEqual({ OR: [{ lifecycle: { equals: "lead", mode: "insensitive" } }] });
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
        firstName: "Sara", lastName: null, email: "", ownerId: undefined,
        marketingOptOut: undefined, notALead: undefined, createdAt: undefined,
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

  it("searches name, phone and email on the server, case-insensitively", async () => {
    await svc.listPage("ws1", { q: "  lina ", page: 1, pageSize: 25 });
    expect(prisma.contact.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: "ws1",
      AND: [
        {
          OR: [
            { name: { contains: "lina", mode: "insensitive" } },
            { phone: { contains: "lina" } },
            { email: { contains: "lina", mode: "insensitive" } },
          ],
        },
      ],
    });
    expect(prisma.contact.count.mock.calls[0][0].where).toEqual(prisma.contact.findMany.mock.calls[0][0].where);
  });

  it("narrows to a segment's members", async () => {
    prisma.segment.findFirst.mockResolvedValue({ id: "g1", origin: "manual", filter: "{}" });
    await svc.listPage("ws1", { segmentId: "g1", page: 1, pageSize: 25 });
    expect(prisma.contact.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: "ws1",
      AND: [{ workspaceId: "ws1", segmentMembers: { some: { segmentId: "g1" } } }],
    });
  });

  it("accepts the full shared filter (lifecycle, owner, opt-out)", async () => {
    await svc.listPage("ws1", { lifecycle: ["lead"], ownerId: "none", optOut: true, page: 1, pageSize: 25 });
    expect(prisma.contact.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: "ws1",
      AND: [{ OR: [{ lifecycle: { equals: "lead", mode: "insensitive" } }] }],
      ownerId: null,
      marketingOptOut: true,
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

describe("ContactsService — editing, owner, delete guard", () => {
  const stored = {
    id: "c1",
    workspaceId: "ws1",
    name: "Sara Khan",
    firstName: "Sara",
    lastName: "Khan",
    email: null,
    phone: null,
    industry: "retail",
    lifecycle: "lead",
    source: "wa",
    value: null,
    lastSeen: "2m",
    tags: "[]",
    convs: 0,
    ownerId: null,
    marketingOptOut: false,
    notALead: false,
    createdAt: new Date("2026-01-01"),
  };
  let prisma: any;
  let svc: ContactsService;

  beforeEach(() => {
    prisma = {
      contact: {
        findFirst: jest.fn().mockResolvedValue(stored),
        update: jest.fn().mockImplementation(async ({ data }) => ({ ...stored, ...data })),
        create: jest.fn().mockImplementation(async ({ data }) => ({ ...stored, ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
      workspaceMember: { findFirst: jest.fn().mockResolvedValue({ id: "m1" }) },
      ticket: { count: jest.fn().mockResolvedValue(0) },
      appointment: { count: jest.fn().mockResolvedValue(0) },
    };
    svc = new ContactsService(prisma as never, {} as never);
  });

  const dataOf = () => prisma.contact.update.mock.calls[0][0].data;

  it("update with firstName/lastName rewrites name", async () => {
    await svc.update("ws1", "c1", { firstName: "Lina" });
    expect(dataOf()).toMatchObject({ firstName: "Lina", name: "Lina Khan" });
  });

  it("update with only name splits into first/last", async () => {
    const res = await svc.update("ws1", "c1", { name: "Omar Al Said" });
    expect(dataOf()).toMatchObject({ name: "Omar Al Said", firstName: "Omar", lastName: "Al Said" });
    expect(res.firstName).toBe("Omar");
  });

  it("empty resulting name → 400", async () => {
    await expect(svc.update("ws1", "c1", { firstName: "", lastName: "" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update("ws1", "c1", { name: "  " })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it("email lower-cased; invalid email → 400", async () => {
    const res = await svc.update("ws1", "c1", { email: "  Sara@Example.COM " });
    expect(dataOf().email).toBe("sara@example.com");
    expect(res.email).toBe("sara@example.com");
    prisma.contact.update.mockClear();
    await expect(svc.update("ws1", "c1", { email: "nope" })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it("normalizes Arabic-Indic digits in phone", async () => {
    await svc.update("ws1", "c1", { phone: "٠٧٩٠٠٠" });
    expect(dataOf().phone).toBe("079000");
  });

  it("owner not a member → 400", async () => {
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    await expect(svc.update("ws1", "c1", { ownerId: "u9" })).rejects.toThrow("owner is not a member");
    expect(prisma.workspaceMember.findFirst).toHaveBeenCalledWith({ where: { workspaceId: "ws1", userId: "u9" } });
  });

  it("owner null unassigns without a membership lookup", async () => {
    await svc.update("ws1", "c1", { ownerId: null });
    expect(dataOf().ownerId).toBeNull();
    expect(prisma.workspaceMember.findFirst).not.toHaveBeenCalled();
  });

  it("create splits a lone name and joins first/last", async () => {
    await svc.create("ws1", { name: "Ali Hassan", industry: "i", lifecycle: "lead", source: "s" } as never);
    expect(prisma.contact.create.mock.calls[0][0].data).toMatchObject({ firstName: "Ali", lastName: "Hassan" });
    prisma.contact.create.mockClear();
    await svc.create("ws1", { firstName: "Ali", lastName: "Hassan", industry: "i", lifecycle: "lead", source: "s" } as never);
    expect(prisma.contact.create.mock.calls[0][0].data).toMatchObject({ name: "Ali Hassan" });
  });

  it("PATCH lastName on a NULL-firstName contact keeps the first part", async () => {
    // Integration-created contacts only carry `name`.
    prisma.contact.findFirst.mockResolvedValue({ ...stored, name: "Sara Khan", firstName: null, lastName: null });
    const res = await svc.update("ws1", "c1", { lastName: "Haddad" });
    expect(dataOf()).toMatchObject({ name: "Sara Haddad", firstName: "Sara", lastName: "Haddad" });
    expect(res.firstName).toBe("Sara");
  });

  it("stale parts (name changed elsewhere) are ignored", async () => {
    // HJZ rewrote name without touching the parts.
    prisma.contact.findFirst.mockResolvedValue({ ...stored, name: "Mona Saleh", firstName: "Sara", lastName: "Khan" });
    await svc.update("ws1", "c1", { lastName: "Odeh" });
    expect(dataOf()).toMatchObject({ name: "Mona Odeh", firstName: "Mona", lastName: "Odeh" });
    prisma.contact.update.mockClear();
    await svc.update("ws1", "c1", { firstName: "Rana" });
    expect(dataOf()).toMatchObject({ name: "Rana Saleh", firstName: "Rana", lastName: "Saleh" });
  });

  it("firstName '' treated as absent", async () => {
    prisma.contact.findFirst.mockResolvedValue({ ...stored, name: "Omar Al Said", firstName: "", lastName: "Al Said" });
    await svc.update("ws1", "c1", { lastName: "Zein" });
    expect(dataOf()).toMatchObject({ name: "Omar Zein", firstName: "Omar", lastName: "Zein" });
  });

  it("shape() derives first/last when stored parts are missing or stale", async () => {
    prisma.contact.findFirst.mockResolvedValue({ ...stored, name: "Mona Saleh", firstName: null, lastName: null });
    const a = await svc.get("ws1", "c1");
    expect(a).toMatchObject({ name: "Mona Saleh", firstName: "Mona", lastName: "Saleh" });
    prisma.contact.findFirst.mockResolvedValue({ ...stored, name: "Mona Saleh", firstName: "Sara", lastName: "Khan" });
    const b = await svc.get("ws1", "c1");
    expect(b).toMatchObject({ firstName: "Mona", lastName: "Saleh" });
    prisma.contact.findFirst.mockResolvedValue(stored);
    const c = await svc.get("ws1", "c1");
    expect(c).toMatchObject({ firstName: "Sara", lastName: "Khan" });
  });

  it("lowercases known lifecycle values on create and update; leaves others alone", async () => {
    await svc.create("ws1", { name: "Ali", industry: "i", lifecycle: "Lead", source: "s" } as never);
    expect(prisma.contact.create.mock.calls[0][0].data.lifecycle).toBe("lead");
    prisma.contact.create.mockClear();
    await svc.create("ws1", { name: "Ali", industry: "i", lifecycle: "VIP Prospect", source: "s" } as never);
    expect(prisma.contact.create.mock.calls[0][0].data.lifecycle).toBe("VIP Prospect");
    await svc.update("ws1", "c1", { lifecycle: "CHURNED" });
    expect(dataOf().lifecycle).toBe("churned");
    prisma.contact.update.mockClear();
    await svc.update("ws1", "c1", { lifecycle: "Blocked" });
    expect(dataOf().lifecycle).toBe("blocked");
    prisma.contact.update.mockClear();
    await svc.update("ws1", "c1", { lifecycle: "Partner" });
    expect(dataOf().lifecycle).toBe("Partner");
    prisma.contact.update.mockClear();
    await svc.update("ws1", "c1", { name: "X" });
    expect(dataOf().lifecycle).toBeUndefined();
  });

  it("delete with linked tickets → 409 with counts", async () => {
    prisma.ticket.count.mockResolvedValue(2);
    prisma.appointment.count.mockResolvedValue(1);
    await expect(svc.remove("ws1", "c1")).rejects.toMatchObject({
      status: 409,
      response: { message: "Contact has linked records", linked: { tickets: 2, appointments: 1 } },
    });
    expect(prisma.contact.delete).not.toHaveBeenCalled();
  });

  it("delete force=1 deletes", async () => {
    prisma.ticket.count.mockResolvedValue(2);
    await expect(svc.remove("ws1", "c1", true)).resolves.toEqual({ ok: true });
    expect(prisma.contact.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("delete foreign contact → 404", async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    await expect(svc.remove("ws2", "c1")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.contact.delete).not.toHaveBeenCalled();
  });
});

describe("ContactsService — select-all ids and paged records", () => {
  let prisma: any;
  let svc: ContactsService;

  beforeEach(() => {
    prisma = {
      contact: {
        findMany: jest.fn().mockResolvedValue([{ id: "a" }, { id: "b" }]),
        count: jest.fn().mockResolvedValue(2),
        findFirst: jest.fn().mockResolvedValue({ id: "c1" }),
      },
      segment: { findFirst: jest.fn() },
      ticket: { findMany: jest.fn().mockResolvedValue([{ id: "t1" }]), count: jest.fn().mockResolvedValue(61) },
      appointment: { findMany: jest.fn().mockResolvedValue([{ id: "ap1" }]), count: jest.fn().mockResolvedValue(3) },
    };
    svc = new ContactsService(prisma as never, new SegmentsService(prisma as never));
  });

  it("select-all ids honours filter", async () => {
    const res = await svc.listIds("ws1", { lifecycle: ["lead"], ownerId: "u1" });
    expect(res).toEqual({ ids: ["a", "b"], total: 2, truncated: false });
    const arg = prisma.contact.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      workspaceId: "ws1",
      AND: [{ OR: [{ lifecycle: { equals: "lead", mode: "insensitive" } }] }],
      ownerId: "u1",
    });
    expect(arg.select).toEqual({ id: true });
    expect(prisma.contact.count.mock.calls[0][0].where).toEqual(arg.where);
  });

  it("select-all caps at 10000 and flags truncated", async () => {
    prisma.contact.count.mockResolvedValue(25_000);
    prisma.contact.findMany.mockResolvedValue(Array.from({ length: 10_000 }, (_, i) => ({ id: `c${i}` })));
    const res = await svc.listIds("ws1", {});
    expect(prisma.contact.findMany.mock.calls[0][0].take).toBe(10_000);
    expect(res.ids).toHaveLength(10_000);
    expect(res.total).toBe(25_000);
    expect(res.truncated).toBe(true);
  });

  it("paged tickets for contact (newest first, pageSize capped at 50)", async () => {
    const res = await svc.pagedTickets("ws1", "c1", { page: 2, pageSize: 500 });
    expect(prisma.ticket.findMany).toHaveBeenCalledWith({
      where: { contactId: "c1", workspaceId: "ws1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { stage: true },
      skip: 50,
      take: 50,
    });
    expect(res).toEqual({ items: [{ id: "t1" }], total: 61, page: 2, pageSize: 50, pageCount: 2 });
  });

  it("paged appointments for contact (newest first)", async () => {
    const res = await svc.pagedAppointments("ws1", "c1", { page: 1, pageSize: 20 });
    expect(prisma.appointment.findMany).toHaveBeenCalledWith({
      where: { contactId: "c1", workspaceId: "ws1" },
      orderBy: [{ startAt: "desc" }, { id: "desc" }],
      skip: 0,
      take: 20,
    });
    expect(res).toMatchObject({ total: 3, page: 1, pageSize: 20, pageCount: 1 });
  });

  it("foreign contact -> 404 for both record lists", async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    await expect(svc.pagedTickets("ws1", "other", { page: 1, pageSize: 10 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.pagedAppointments("ws1", "other", { page: 1, pageSize: 10 })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({ where: { id: "other", workspaceId: "ws1" }, select: { id: true } });
  });
});
