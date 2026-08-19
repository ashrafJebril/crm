import { NotFoundException } from "@nestjs/common";
import { TagsService, hueForName } from "./tags.module";

describe("hueForName", () => {
  it("is deterministic and lands on the 12-step wheel", () => {
    const h1 = hueForName("VIP");
    expect(h1).toBe(hueForName("VIP"));
    const n = Number(h1);
    expect(n % 30).toBe(0);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThan(360);
  });
});

describe("TagsService", () => {
  let prisma: {
    tag: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
    contact: { findMany: jest.Mock; update: jest.Mock };
    $queryRawUnsafe: jest.Mock;
    $executeRawUnsafe: jest.Mock;
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock;
  };
  let svc: TagsService;

  beforeEach(() => {
    prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "VIP", color: "90" }]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new", ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "t1", name: "VIP", color: "90", ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
      contact: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    svc = new TagsService(prisma as never);
  });

  it("create is idempotent: an existing name returns the existing row", async () => {
    prisma.tag.findFirst.mockResolvedValue({ id: "t1", name: "VIP", color: "90" });
    const row = await svc.create("ws1", "VIP");
    expect(row.id).toBe("t1");
    expect(prisma.tag.create).not.toHaveBeenCalled();
  });

  it("create trims the name and assigns a wheel hue when color omitted", async () => {
    await svc.create("ws1", "  Hot Lead  ");
    expect(prisma.tag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Hot Lead", workspaceId: "ws1", color: hueForName("Hot Lead") }),
    });
  });

  it("rename 404s on a foreign/unknown tag id", async () => {
    prisma.tag.findFirst.mockResolvedValue(null);
    await expect(svc.update("ws1", "nope", { name: "X" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rename with an unchanged name skips contact propagation", async () => {
    prisma.tag.findFirst.mockResolvedValue({ id: "t1", name: "VIP", color: "90" });
    await svc.update("ws1", "t1", { name: "VIP", color: "120" });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("assign validates that all contactIds belong to the workspace", async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: "c1" }]); // only 1 of 2 found
    await expect(
      svc.assign("ws1", { contactIds: ["c1", "foreign"], add: ["VIP"] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
