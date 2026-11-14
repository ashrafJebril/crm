import { BadRequestException, NotFoundException } from "@nestjs/common";
import { SegmentsController } from "./segments.controller";
import { SegmentsService } from "./segments.service";
import { createAudienceDb } from "./audience-test-db";

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

  it("list counts manual/hjz segments by membership, crm by its rules (SP-16: SegmentsService.listRows)", async () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const row = (id: string, origin: string, filter: string) => ({
      id, workspaceId: "ws1", origin, filter, name: id, nameAr: null, color: null, rules: null, version: 0,
      memberCount: null, countedAt: null, createdAt: at, updatedAt: at,
    });
    const contact = (id: string, lifecycle: string) => ({ id, workspaceId: "ws1", lifecycle, tags: "[]", name: id, phone: null });
    const fake = createAudienceDb({
      segment: [row("s1", "manual", "{}"), row("s2", "crm", '{"lifecycle":["lead"]}')],
      segmentMember: Array.from({ length: 7 }, (_, i) => ({ segmentId: "s1", contactId: `m${i}` })),
      contact: [...Array.from({ length: 5 }, (_, i) => contact(`l${i}`, "lead")), contact("x", "customer")],
    });
    const realCtrl = new SegmentsController(fake.prisma as never, new SegmentsService(fake.prisma as never), {} as never);
    const rows = await realCtrl.list("ws1");
    expect(rows.find((r: { id: string }) => r.id === "s1")!.count).toBe(7);
    expect(rows.find((r: { id: string }) => r.id === "s2")!.count).toBe(5);
    expect(rows[0].origin).toBeDefined();
  });
});

describe("createManualGroup (SP-12 follow-up helper)", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createManualGroup } = require("./segment-members") as typeof import("./segment-members");

  it("creates a manual group with an empty filter, trims the name and emits once", async () => {
    const create = jest.fn(async (a: { data: Record<string, unknown> }) => ({ id: "g1", ...a.data }));
    const outbound = { emitSegmentUpserted: jest.fn(async () => true) };
    const seg = await createManualGroup({ segment: { create } } as never, outbound, "ws1", { name: "  Readers ", nameAr: " القراء " });
    expect(create).toHaveBeenCalledWith({
      data: { workspaceId: "ws1", name: "Readers", nameAr: "القراء", color: null, filter: "{}", origin: "manual" },
    });
    expect(seg.id).toBe("g1");
    expect(outbound.emitSegmentUpserted).toHaveBeenCalledWith("ws1", "g1");
  });

  it("rejects a blank or over-long name with 400 and creates nothing", async () => {
    const create = jest.fn();
    const outbound = { emitSegmentUpserted: jest.fn() };
    await expect(createManualGroup({ segment: { create } } as never, outbound, "ws1", { name: "  " })).rejects.toBeInstanceOf(BadRequestException);
    await expect(createManualGroup({ segment: { create } } as never, outbound, "ws1", { name: "x".repeat(121) })).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});
