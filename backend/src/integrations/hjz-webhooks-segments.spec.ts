import { Test } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { HjzWebhooksService } from "./hjz-webhooks.service";
import { PrismaService } from "../prisma/prisma.service";

describe("HjzWebhooksService.verifySecret — segment guard", () => {
  let svc: HjzWebhooksService;

  beforeEach(async () => {
    process.env.HJZ_WEBHOOK_SECRET = "test-secret-segs";
    const moduleRef = await Test.createTestingModule({
      providers: [
        HjzWebhooksService,
        {
          provide: PrismaService,
          useValue: {
            workspace: { upsert: jest.fn(), findUnique: jest.fn() },
            contact: { findMany: jest.fn() },
            segment: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
            segmentMember: { deleteMany: jest.fn(), createMany: jest.fn() },
          },
        },
      ],
    }).compile();
    svc = moduleRef.get(HjzWebhooksService);
  });

  it("throws ForbiddenException when secret is undefined", () => {
    expect(() => svc.verifySecret(undefined)).toThrow(ForbiddenException);
  });

  it("throws ForbiddenException when secret is wrong", () => {
    expect(() => svc.verifySecret("wrong-secret")).toThrow(ForbiddenException);
  });
});

describe("HjzWebhooksService.handleSegment — upsert", () => {
  let svc: HjzWebhooksService;
  let prisma: any;
  const segmentId = "seg-1";

  beforeEach(async () => {
    process.env.HJZ_WEBHOOK_SECRET = "test-secret-segs";
    prisma = {
      workspace: {
        upsert: jest.fn().mockResolvedValue({ id: "ws-1", externalTenantId: "hjz-tenant-segs" }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      contact: {
        findMany: jest.fn().mockResolvedValue([{ id: "cid-a" }, { id: "cid-b" }]),
      },
      segment: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: segmentId }),
        update: jest.fn().mockResolvedValue({ id: segmentId }),
        delete: jest.fn().mockResolvedValue({ id: segmentId }),
      },
      segmentMember: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        HjzWebhooksService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    svc = moduleRef.get(HjzWebhooksService);
  });

  const rules = [{ conditions: [{ attribute: "tags", operator: "is", value: ["vip"] }] }];

  it("upserts segment + members and returns { ok: true }", async () => {
    const result = await svc.handleSegment({
      event: "segment.upserted",
      segment: {
        id: "hjz-seg-1",
        tenantId: "hjz-tenant-segs",
        name: "Loyal",
        rules,
        clientIds: ["c-a", "c-b"],
      },
    });

    // workspace resolved
    expect(prisma.workspace.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalTenantId: "hjz-tenant-segs" } }),
    );

    // segment created (no existing)
    expect(prisma.segment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Loyal",
          origin: "hjz",
          externalId: "hjz-seg-1",
          externalRules: JSON.stringify(rules),
          filter: "{}",
          workspaceId: "ws-1",
        }),
      }),
    );
    expect(prisma.segment.create.mock.calls[0][0].data).toHaveProperty("lastSyncedAt");

    // membership replaced
    expect(prisma.segmentMember.deleteMany).toHaveBeenCalledWith({ where: { segmentId } });
    expect(prisma.segmentMember.createMany).toHaveBeenCalledWith({
      data: [
        { segmentId, contactId: "cid-a" },
        { segmentId, contactId: "cid-b" },
      ],
      skipDuplicates: true,
    });

    expect(result).toEqual({ ok: true });
  });
});

describe("HjzWebhooksService.handleSegment — re-upsert shrinks membership", () => {
  let svc: HjzWebhooksService;
  let prisma: any;
  const segmentId = "seg-existing";

  beforeEach(async () => {
    process.env.HJZ_WEBHOOK_SECRET = "test-secret-segs";
    prisma = {
      workspace: {
        upsert: jest.fn().mockResolvedValue({ id: "ws-1", externalTenantId: "hjz-tenant-segs" }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      contact: {
        findMany: jest.fn().mockResolvedValue([{ id: "cid-a" }]),
      },
      segment: {
        findFirst: jest.fn().mockResolvedValue({ id: segmentId }),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: segmentId }),
        delete: jest.fn(),
      },
      segmentMember: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        HjzWebhooksService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    svc = moduleRef.get(HjzWebhooksService);
  });

  it("deleteMany is called to wipe old members and createMany rebuilds with one entry", async () => {
    await svc.handleSegment({
      event: "segment.upserted",
      segment: {
        id: "hjz-seg-1",
        tenantId: "hjz-tenant-segs",
        name: "Loyal",
        rules: [],
        clientIds: ["c-a"],
      },
    });

    expect(prisma.segment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: segmentId } }),
    );
    expect(prisma.segment.create).not.toHaveBeenCalled();
    expect(prisma.segmentMember.deleteMany).toHaveBeenCalledWith({ where: { segmentId } });
    expect(prisma.segmentMember.createMany).toHaveBeenCalledWith({
      data: [{ segmentId, contactId: "cid-a" }],
      skipDuplicates: true,
    });
  });
});

describe("HjzWebhooksService.handleSegment — zero-membership upsert", () => {
  let svc: HjzWebhooksService;
  let prisma: any;
  const segmentId = "seg-empty";

  beforeEach(async () => {
    process.env.HJZ_WEBHOOK_SECRET = "test-secret-segs";
    prisma = {
      workspace: {
        upsert: jest.fn().mockResolvedValue({ id: "ws-1", externalTenantId: "hjz-tenant-segs" }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      contact: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      segment: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: segmentId }),
        update: jest.fn(),
        delete: jest.fn(),
      },
      segmentMember: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        HjzWebhooksService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    svc = moduleRef.get(HjzWebhooksService);
  });

  it("calls deleteMany and createMany even when contacts list is empty", async () => {
    const result = await svc.handleSegment({
      event: "segment.upserted",
      segment: {
        id: "hjz-seg-empty",
        tenantId: "hjz-tenant-segs",
        name: "Empty",
        rules: [],
        clientIds: [],
      },
    });

    // Both membership operations should be called even with zero contacts
    expect(prisma.segmentMember.deleteMany).toHaveBeenCalledWith({ where: { segmentId } });
    expect(prisma.segmentMember.createMany).toHaveBeenCalledWith({
      data: [],
      skipDuplicates: true,
    });

    expect(result).toEqual({ ok: true });
  });
});

describe("HjzWebhooksService.handleSegment — delete", () => {
  let svc: HjzWebhooksService;
  let prisma: any;
  const segmentId = "seg-xyz";

  beforeEach(async () => {
    process.env.HJZ_WEBHOOK_SECRET = "test-secret-segs";
    prisma = {
      workspace: {
        upsert: jest.fn().mockResolvedValue({ id: "ws-1", externalTenantId: "hjz-tenant-segs" }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      contact: { findMany: jest.fn() },
      segment: {
        findFirst: jest.fn().mockResolvedValue({ id: segmentId }),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({ id: segmentId }),
      },
      segmentMember: { deleteMany: jest.fn(), createMany: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        HjzWebhooksService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    svc = moduleRef.get(HjzWebhooksService);
  });

  it("deletes segment by id on segment.deleted", async () => {
    const result = await svc.handleSegment({
      event: "segment.deleted",
      segment: { id: "hjz-seg-1", tenantId: "hjz-tenant-segs" },
    });

    expect(prisma.segment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ origin: "hjz", externalId: "hjz-seg-1" }),
      }),
    );
    expect(prisma.segment.delete).toHaveBeenCalledWith({ where: { id: segmentId } });
    expect(result).toEqual({ ok: true });
  });
});
