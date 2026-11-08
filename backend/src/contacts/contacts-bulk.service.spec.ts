import { BadRequestException, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BULK_IDS_CAP, ContactsBulkService, PIPELINE_BULK_CAP } from "./contacts-bulk.service";
import { BulkContactsDto } from "./contacts.dto";

describe("ContactsBulkService", () => {
  let prisma: any;
  let contacts: { listIds: jest.Mock };
  let tags: { assign: jest.Mock };
  let tickets: { createTicket: jest.Mock };
  let outbound: { emitSegmentUpserted: jest.Mock };
  let svc: ContactsBulkService;

  beforeEach(() => {
    prisma = {
      contact: {
        findMany: jest.fn().mockImplementation(({ where }) =>
          Promise.resolve(((where.id?.in as string[]) ?? []).map((id) => ({ id, name: `N-${id}` }))),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      segment: { findFirst: jest.fn() },
      segmentMember: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
      workspaceMember: { findFirst: jest.fn().mockResolvedValue({ id: "m1" }) },
      pipeline: { findFirst: jest.fn().mockResolvedValue({ id: "p1" }) },
      ticketStage: { findFirst: jest.fn().mockResolvedValue({ id: "first" }) },
      ticket: { findMany: jest.fn().mockResolvedValue([]) },
    };
    contacts = { listIds: jest.fn() };
    tags = { assign: jest.fn().mockResolvedValue({ contactsUpdated: 2 }) };
    tickets = { createTicket: jest.fn().mockResolvedValue({ id: "t" }) };
    outbound = { emitSegmentUpserted: jest.fn() };
    svc = new ContactsBulkService(prisma, contacts as never, tags as never, tickets as never, outbound as never);
  });

  it("bulk requires exactly one of ids/filter", async () => {
    await expect(svc.run("ws1", { op: "setOptOut", value: true } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.run("ws1", { ids: ["a"], filter: {}, op: "setOptOut", value: true } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an unknown op", async () => {
    await expect(svc.run("ws1", { ids: ["a"], op: "explode" } as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("ids from another workspace -> 404", async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: "a" }]);
    await expect(svc.run("ws1", { ids: ["a", "foreign"], op: "setOptOut", value: true })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws1", id: { in: ["a", "foreign"] } },
      select: { id: true },
    });
  });

  it("filter mode resolves ids via the shared filter and reports truncation", async () => {
    contacts.listIds.mockResolvedValue({ ids: ["a", "b"], total: 30_000, truncated: true });
    const res = await svc.run("ws1", { filter: { lifecycle: ["lead"] }, op: "setNotALead", value: true });
    expect(contacts.listIds).toHaveBeenCalledWith("ws1", { lifecycle: ["lead"] });
    expect(prisma.contact.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws1", id: { in: ["a", "b"] } },
      data: { notALead: true },
    });
    expect(res).toEqual({ affected: 2, truncated: true });
  });

  it("addTags / removeTags delegate to TagsService.assign", async () => {
    expect(await svc.run("ws1", { ids: ["a", "b"], op: "addTags", names: ["VIP"] })).toEqual({ affected: 2 });
    expect(tags.assign).toHaveBeenCalledWith("ws1", { contactIds: ["a", "b"], add: ["VIP"] });
    await svc.run("ws1", { ids: ["a", "b"], op: "removeTags", names: ["Old"] });
    expect(tags.assign).toHaveBeenLastCalledWith("ws1", { contactIds: ["a", "b"], remove: ["Old"] });
  });

  it("addToGroup adds to a manual group and notifies outbound", async () => {
    prisma.segment.findFirst.mockResolvedValue({ id: "g1", origin: "manual" });
    const res = await svc.run("ws1", { ids: ["a", "b"], op: "addToGroup", segmentId: "g1" });
    expect(res).toEqual({ affected: 2 });
    expect(prisma.segmentMember.createMany).toHaveBeenCalledWith({
      data: [
        { segmentId: "g1", contactId: "a" },
        { segmentId: "g1", contactId: "b" },
      ],
      skipDuplicates: true,
    });
    expect(outbound.emitSegmentUpserted).toHaveBeenCalledWith("ws1", "g1");
  });

  it("addToGroup rejects non-manual group", async () => {
    prisma.segment.findFirst.mockResolvedValue({ id: "s1", origin: "crm" });
    await expect(svc.run("ws1", { ids: ["a"], op: "addToGroup", segmentId: "s1" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.segmentMember.createMany).not.toHaveBeenCalled();
  });

  it("setOwner checks membership; null unassigns without a check", async () => {
    await svc.run("ws1", { ids: ["a", "b"], op: "setOwner", ownerId: "u1" });
    expect(prisma.workspaceMember.findFirst).toHaveBeenCalledWith({ where: { workspaceId: "ws1", userId: "u1" } });
    expect(prisma.contact.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws1", id: { in: ["a", "b"] } },
      data: { ownerId: "u1" },
    });
    prisma.workspaceMember.findFirst.mockClear();
    await svc.run("ws1", { ids: ["a", "b"], op: "setOwner", ownerId: null });
    expect(prisma.workspaceMember.findFirst).not.toHaveBeenCalled();
    expect(prisma.contact.updateMany).toHaveBeenLastCalledWith({
      where: { workspaceId: "ws1", id: { in: ["a", "b"] } },
      data: { ownerId: null },
    });
  });

  it("setOwner rejects a non-member", async () => {
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    await expect(svc.run("ws1", { ids: ["a"], op: "setOwner", ownerId: "x" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  it("setOptOut maps to marketingOptOut", async () => {
    await svc.run("ws1", { ids: ["a", "b"], op: "setOptOut", value: true });
    expect(prisma.contact.updateMany.mock.calls[0][0].data).toEqual({ marketingOptOut: true });
  });

  it("addToPipeline skips contacts with an open ticket and uses first stage", async () => {
    prisma.ticket.findMany.mockResolvedValue([{ contactId: "b" }]);
    const res = await svc.run("ws1", { ids: ["a", "b", "c"], op: "addToPipeline", pipelineId: "p1" });
    expect(prisma.ticket.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws1", pipelineId: "p1", closedAt: null, contactId: { in: ["a", "b", "c"] } },
      select: { contactId: true },
    });
    expect(prisma.ticketStage.findFirst).toHaveBeenCalledWith({
      where: { pipelineId: "p1", workspaceId: "ws1" },
      orderBy: { order: "asc" },
    });
    expect(tickets.createTicket).toHaveBeenCalledTimes(2);
    expect(tickets.createTicket).toHaveBeenCalledWith("ws1", {
      pipelineId: "p1",
      stageId: "first",
      contactId: "a",
      title: "N-a",
    });
    expect(res).toEqual({ affected: 2, created: 2, skipped: 1 });
  });

  it("addToPipeline honours an explicit stageId and 404s a foreign pipeline", async () => {
    await svc.run("ws1", { ids: ["a"], op: "addToPipeline", pipelineId: "p1", stageId: "s9" });
    expect(prisma.ticketStage.findFirst).not.toHaveBeenCalled();
    expect(tickets.createTicket.mock.calls[0][1].stageId).toBe("s9");
    prisma.pipeline.findFirst.mockResolvedValue(null);
    await expect(svc.run("ws1", { ids: ["a"], op: "addToPipeline", pipelineId: "zz" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("bulk delete without force reports blocked", async () => {
    // contact.findMany: ownership check first, then the linked-records lookup.
    prisma.contact.findMany
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }, { id: "c" }])
      .mockResolvedValueOnce([{ id: "b" }]);
    prisma.contact.deleteMany.mockResolvedValue({ count: 2 });
    const res = await svc.run("ws1", { ids: ["a", "b", "c"], op: "delete" });
    expect(prisma.contact.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws1", id: { in: ["a", "c"] } } });
    expect(res).toEqual({ affected: 2, skipped: 1, blocked: ["b"] });
  });

  it("bulk delete with force removes everything", async () => {
    prisma.contact.deleteMany.mockResolvedValue({ count: 3 });
    const res = await svc.run("ws1", { ids: ["a", "b", "c"], op: "delete", force: true });
    expect(prisma.contact.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "ws1", id: { in: ["a", "b", "c"] } } });
    expect(res).toEqual({ affected: 3 });
  });

  it("more than 10 000 ids -> 400, before any lookup", async () => {
    const ids = Array.from({ length: BULK_IDS_CAP + 1 }, (_, i) => `c${i}`);
    await expect(svc.run("ws1", { ids, op: "setOptOut", value: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  it("BulkContactsDto rejects more than 10 000 ids at validation", async () => {
    const tooMany = plainToInstance(BulkContactsDto, {
      op: "setOptOut",
      value: true,
      ids: Array.from({ length: BULK_IDS_CAP + 1 }, (_, i) => `c${i}`),
    });
    expect((await validate(tooMany)).map((e) => e.property)).toContain("ids");
    const ok = plainToInstance(BulkContactsDto, { op: "setOptOut", value: true, ids: ["a"] });
    expect(await validate(ok)).toEqual([]);
  });

  it("addToPipeline over 500 contacts -> 400 and creates nothing", async () => {
    const ids = Array.from({ length: PIPELINE_BULK_CAP + 1 }, (_, i) => `c${i}`);
    await expect(svc.run("ws1", { ids, op: "addToPipeline", pipelineId: "p1" })).rejects.toThrow(
      "Add up to 500 contacts to a pipeline at a time.",
    );
    contacts.listIds.mockResolvedValue({ ids, total: ids.length, truncated: false });
    await expect(svc.run("ws1", { filter: {}, op: "addToPipeline", pipelineId: "p1" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tickets.createTicket).not.toHaveBeenCalled();
    // Exactly 500 is allowed.
    tickets.createTicket.mockClear();
    await svc.run("ws1", { ids: ids.slice(0, PIPELINE_BULK_CAP), op: "addToPipeline", pipelineId: "p1" });
    expect(tickets.createTicket).toHaveBeenCalledTimes(PIPELINE_BULK_CAP);
  });

  it("delete in filter mode -> 400 (delete needs explicit ids)", async () => {
    contacts.listIds.mockResolvedValue({ ids: ["a"], total: 1, truncated: false });
    await expect(svc.run("ws1", { filter: {}, op: "delete", force: true })).rejects.toThrow("Delete needs explicit ids");
    expect(contacts.listIds).not.toHaveBeenCalled();
    expect(prisma.contact.deleteMany).not.toHaveBeenCalled();
  });
});
