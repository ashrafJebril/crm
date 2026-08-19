import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { TagsService, hueForName, rewriteFilterTagName } from "./tags.module";

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

describe("rewriteFilterTagName", () => {
  it("rewrites an exact element in tagsAny/tagsAll and leaves near-misses alone", () => {
    expect(rewriteFilterTagName(JSON.stringify({ tagsAny: ["VIP"] }), "VIP", "Gold")).toBe(
      JSON.stringify({ tagsAny: ["Gold"] }),
    );
    expect(rewriteFilterTagName(JSON.stringify({ tagsAll: ["VIP", "Pro"] }), "VIP", "Gold")).toBe(
      JSON.stringify({ tagsAll: ["Gold", "Pro"] }),
    );
    // "VIPER" must never be touched by a rename of "VIP".
    expect(rewriteFilterTagName(JSON.stringify({ tagsAny: ["VIPER"] }), "VIP", "Gold")).toBeNull();
  });

  it("returns null for untouched, malformed, or non-object filters", () => {
    expect(rewriteFilterTagName("{}", "VIP", "Gold")).toBeNull();
    expect(rewriteFilterTagName(JSON.stringify({ lifecycle: ["lead"] }), "VIP", "Gold")).toBeNull();
    expect(rewriteFilterTagName("not json", "VIP", "Gold")).toBeNull();
    expect(rewriteFilterTagName("[1,2]", "VIP", "Gold")).toBeNull();
  });

  it("dedupes when the filter already references the target name", () => {
    expect(
      rewriteFilterTagName(JSON.stringify({ tagsAny: ["VIP", "Gold"] }), "VIP", "Gold"),
    ).toBe(JSON.stringify({ tagsAny: ["Gold"] }));
  });
});

describe("TagsService", () => {
  let tx: {
    tag: { update: jest.Mock; delete: jest.Mock };
    contact: { update: jest.Mock };
    segment: { findMany: jest.Mock; update: jest.Mock };
    $executeRaw: jest.Mock;
  };
  let prisma: {
    tag: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
    contact: { findMany: jest.Mock; update: jest.Mock };
    segment: { findMany: jest.Mock; update: jest.Mock };
    $queryRawUnsafe: jest.Mock;
    $executeRawUnsafe: jest.Mock;
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock;
    $transaction: jest.Mock;
  };
  let svc: TagsService;

  beforeEach(() => {
    tx = {
      tag: {
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "t1", name: "VIP", color: "90", ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
      contact: { update: jest.fn().mockResolvedValue({}) },
      segment: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "VIP", color: "90" }]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new", ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "t1", name: "VIP", color: "90", ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
      contact: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      segment: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      // Interactive-transaction shape: hand the callback a tx client.
      $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
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

  it("create rejects a whitespace-only name with 400 and writes nothing", async () => {
    await expect(svc.create("ws1", "   ")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tag.findFirst).not.toHaveBeenCalled();
    expect(prisma.tag.create).not.toHaveBeenCalled();
  });

  it("rename 404s on a foreign/unknown tag id", async () => {
    prisma.tag.findFirst.mockResolvedValue(null);
    await expect(svc.update("ws1", "nope", { name: "X" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rename with an unchanged name skips contact propagation", async () => {
    prisma.tag.findFirst.mockResolvedValue({ id: "t1", name: "VIP", color: "90" });
    await svc.update("ws1", "t1", { name: "VIP", color: "120" });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.segment.findMany).not.toHaveBeenCalled();
  });

  it("rename to an existing catalog name 409s BEFORE any propagation runs", async () => {
    prisma.tag.findFirst
      .mockResolvedValueOnce({ id: "t1", name: "VIP", color: "90" }) // the tag being renamed
      .mockResolvedValueOnce({ id: "t2", name: "Gold", color: "30" }); // the clash
    await expect(svc.update("ws1", "t1", { name: "Gold" })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled(); // no contact rewrite
    expect(tx.tag.update).not.toHaveBeenCalled();
    expect(prisma.tag.update).not.toHaveBeenCalled();
  });

  it("rename propagates through one transaction: contacts, crm segment filters, catalog row", async () => {
    prisma.tag.findFirst
      .mockResolvedValueOnce({ id: "t1", name: "VIP", color: "90" })
      .mockResolvedValueOnce(null); // no clash
    tx.$executeRaw.mockResolvedValue(3);
    tx.segment.findMany.mockResolvedValue([
      { id: "s1", filter: JSON.stringify({ tagsAny: ["VIP"] }) },
      { id: "s2", filter: JSON.stringify({ tagsAny: ["VIPER"] }) }, // near-miss: untouched
    ]);
    const res = await svc.update("ws1", "t1", { name: "Gold" });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.segment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws1", origin: "crm" } }),
    );
    expect(tx.segment.update).toHaveBeenCalledTimes(1);
    expect(tx.segment.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { filter: JSON.stringify({ tagsAny: ["Gold"] }) },
    });
    expect(tx.tag.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { name: "Gold", color: undefined },
    });
    expect(res.contactsUpdated).toBe(3);
    expect(res.segmentsUpdated).toBe(1);
  });

  it("rename dedupes rewritten contact arrays (DISTINCT in the jsonb_agg)", async () => {
    prisma.tag.findFirst
      .mockResolvedValueOnce({ id: "t1", name: "VIP", color: "90" })
      .mockResolvedValueOnce(null);
    await svc.update("ws1", "t1", { name: "Gold" });
    const sql = (tx.$executeRaw.mock.calls[0][0] as string[]).join("?");
    expect(sql).toContain("jsonb_agg(DISTINCT");
    expect(sql).toContain('"workspaceId" =');
  });

  it("delete strips the name from contacts and drops the row in one transaction", async () => {
    prisma.tag.findFirst.mockResolvedValue({ id: "t1", name: "VIP", color: "90" });
    tx.$executeRaw.mockResolvedValue(2);
    const res = await svc.remove("ws1", "t1");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.tag.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(res).toEqual({ ok: true, contactsUpdated: 2 });
  });

  it("assign validates that all contactIds belong to the workspace", async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: "c1" }]); // only 1 of 2 found
    await expect(
      svc.assign("ws1", { contactIds: ["c1", "foreign"], add: ["VIP"] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("assign writes every contact through a single transaction", async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: "c1", tags: "[]" },
      { id: "c2", tags: '["Pro"]' },
    ]);
    prisma.tag.findFirst.mockResolvedValue({ id: "t1", name: "VIP", color: "90" });
    const res = await svc.assign("ws1", { contactIds: ["c1", "c2"], add: ["VIP"] });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.contact.update).toHaveBeenCalledTimes(2);
    expect(prisma.contact.update).not.toHaveBeenCalled();
    expect(res).toEqual({ contactsUpdated: 2 });
  });
});
