import { BadRequestException, NotFoundException } from "@nestjs/common";
import { SegmentsController } from "./segments.module";

describe("SegmentsController manual-group members", () => {
  let prisma: {
    segment: { findFirst: jest.Mock; findMany: jest.Mock };
    segmentMember: { createMany: jest.Mock; deleteMany: jest.Mock; count: jest.Mock; findMany: jest.Mock };
    contact: { findMany: jest.Mock };
  };
  let svc: { countByFilter: jest.Mock; parseFilter: jest.Mock };
  let ctrl: SegmentsController;

  beforeEach(() => {
    prisma = {
      segment: {
        findFirst: jest.fn().mockResolvedValue({ id: "s1", origin: "manual" }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      segmentMember: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      contact: { findMany: jest.fn().mockResolvedValue([{ id: "c1" }, { id: "c2" }]) },
    };
    svc = { countByFilter: jest.fn().mockResolvedValue(5), parseFilter: jest.fn().mockReturnValue({}) };
    ctrl = new SegmentsController(prisma as never, svc as never, { emitSegmentUpserted: jest.fn(), emitSegmentDeleted: jest.fn() } as never);
  });

  it("adds members idempotently and workspace-validates contacts", async () => {
    const res = await ctrl.addMembers("ws1", "s1", { contactIds: ["c1", "c2"] });
    expect(prisma.segmentMember.createMany).toHaveBeenCalledWith({
      data: [
        { segmentId: "s1", contactId: "c1" },
        { segmentId: "s1", contactId: "c2" },
      ],
      skipDuplicates: true,
    });
    expect(res).toEqual({ added: 2 });
  });

  it("404s when a contactId is foreign to the workspace", async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: "c1" }]); // c2 missing
    await expect(ctrl.addMembers("ws1", "s1", { contactIds: ["c1", "c2"] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.segmentMember.createMany).not.toHaveBeenCalled();
  });

  it("400s member ops on non-manual segments", async () => {
    prisma.segment.findFirst.mockResolvedValue({ id: "s1", origin: "crm" });
    await expect(ctrl.addMembers("ws1", "s1", { contactIds: ["c1"] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("list counts manual/hjz segments by membership, crm by filter", async () => {
    prisma.segment.findMany.mockResolvedValue([
      { id: "s1", origin: "manual", filter: "{}", name: "G", nameAr: null, color: null, createdAt: new Date(), updatedAt: new Date() },
      { id: "s2", origin: "crm", filter: "{}", name: "S", nameAr: null, color: null, createdAt: new Date(), updatedAt: new Date() },
    ]);
    prisma.segmentMember.count.mockResolvedValue(7);
    const rows = await ctrl.list("ws1");
    expect(rows.find((r: { id: string }) => r.id === "s1")!.count).toBe(7);
    expect(rows.find((r: { id: string }) => r.id === "s2")!.count).toBe(5);
    expect(rows[0].origin).toBeDefined();
  });
});
