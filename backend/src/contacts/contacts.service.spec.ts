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
