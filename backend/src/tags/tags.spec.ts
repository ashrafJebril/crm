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
    tag: { update: jest.Mock; delete: jest.Mock; deleteMany: jest.Mock };
    contact: { update: jest.Mock; updateMany: jest.Mock };
    segment: { findMany: jest.Mock; update: jest.Mock };
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
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
  const sqlOf = (call: unknown[]) => (call[0] as string[]).join("?");
  /** `tx.$executeRaw` calls on Contact (not the SP-16 lock or the batched Segment writes). */
  const contactRaw = () => tx.$executeRaw.mock.calls.filter((c: unknown[]) => sqlOf(c).includes('UPDATE "Contact"'));
  /** The rows of the one batched Segment rewrite (SP-16 live verification). */
  const batchRows = () => {
    const calls = tx.$executeRaw.mock.calls.filter((c: unknown[]) => sqlOf(c).includes("jsonb_to_recordset"));
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(2)).toEqual(["ws1"]);
    return JSON.parse(calls[0][1] as string);
  };

  beforeEach(() => {
    tx = {
      tag: {
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "t1", name: "VIP", color: "90", ...data })),
        delete: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockImplementation(({ where }) =>
          Promise.resolve({ count: where.id.in.length }),
        ),
      },
      contact: { update: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      segment: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
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
      $transaction: jest.fn((fn: (t: unknown) => unknown, _opts?: unknown) => fn(tx)),
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
    // SP-16: one batched statement (version + 1 for legacy rows too, review m1); a rename clears no counts.
    expect(tx.segment.update).not.toHaveBeenCalled();
    expect(batchRows()).toEqual([{ id: "s1", rules: null, filter: JSON.stringify({ tagsAny: ["Gold"] }) }]);
    expect(tx.$executeRaw.mock.calls.some((c: unknown[]) => sqlOf(c).includes('"countedAt" = NULL'))).toBe(false);
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
    // SP-16: the workspace audience lock comes first, then the contact rewrite.
    expect(sqlOf(tx.$executeRaw.mock.calls[0])).toContain("pg_advisory_xact_lock");
    const sql = sqlOf(contactRaw()[0]);
    expect(sql).toContain("jsonb_agg(DISTINCT");
    expect(sql).toContain('"workspaceId" =');
  });

  it("delete strips the name from contacts and drops the row in one transaction", async () => {
    prisma.tag.findFirst.mockResolvedValue({ id: "t1", name: "VIP", color: "90" });
    tx.$executeRaw.mockResolvedValue(2);
    const res = await svc.remove("ws1", "t1");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(contactRaw()).toHaveLength(1);
    expect(tx.tag.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    // SP-16: an unreferenced tag deletes as before; no audience was marked.
    expect(res).toEqual({ ok: true, contactsUpdated: 2, audiencesMarked: 0 });
  });

  describe("merge", () => {
    const tags = [
      { id: "a", name: "VIP", color: "90" },
      { id: "b", name: "Gold", color: "30" },
      { id: "into", name: "Premium", color: "60" },
    ];
    beforeEach(() => {
      prisma.tag.findMany.mockResolvedValue(tags);
    });

    it("merge rewrites exact elements only (VIP≠VIPER)", async () => {
      tx.$executeRaw.mockResolvedValue(2);
      const res = await svc.merge("ws1", ["a", "b"], "into");
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(contactRaw()).toHaveLength(2);
      const call = contactRaw()[0];
      const sql = sqlOf(call);
      expect(sql).toContain("jsonb_agg(DISTINCT");
      expect(sql).toContain('"tags"::jsonb ?');
      expect(sql).not.toContain("LIKE");
      expect(call.slice(1)).toEqual(["VIP", "Premium", "ws1", "VIP"]);
      expect(contactRaw()[1].slice(1)).toEqual(["Gold", "Premium", "ws1", "Gold"]);
      expect(tx.tag.delete).not.toHaveBeenCalled();
      expect(res).toEqual({ contactsUpdated: 4, segmentsUpdated: 0, removed: 2 });
    });

    it("merge rewrites segment filters", async () => {
      tx.segment.findMany.mockResolvedValue([
        { id: "s1", filter: JSON.stringify({ tagsAny: ["VIP", "Premium"] }) },
        { id: "s2", filter: JSON.stringify({ tagsAll: ["VIPER"] }) },
      ]);
      const res = await svc.merge("ws1", ["a"], "into");
      expect(tx.segment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: "ws1", origin: "crm" } }),
      );
      // SP-16: one batched rewrite, then one count-cache clear (F2).
      expect(tx.segment.update).not.toHaveBeenCalled();
      expect(batchRows()).toEqual([{ id: "s1", rules: null, filter: JSON.stringify({ tagsAny: ["Premium"] }) }]);
      const clear = tx.$executeRaw.mock.calls.filter((c: unknown[]) => sqlOf(c).includes('"countedAt" = NULL'));
      expect(clear).toHaveLength(1);
      expect(clear[0].slice(1)).toEqual(["ws1", ["s1"]]);
      expect(tx.tag.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["a"] }, workspaceId: "ws1" },
      });
      expect(res.segmentsUpdated).toBe(1);
      expect(res.removed).toBe(1);
    });

    it("into in from → 400", async () => {
      await expect(svc.merge("ws1", ["a", "into"], "into")).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("foreign tag → 404", async () => {
      prisma.tag.findMany.mockResolvedValue([tags[0], tags[2]]); // "b" not in workspace
      await expect(svc.merge("ws1", ["a", "b"], "into")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  it("assign validates that all contactIds belong to the workspace", async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: "c1" }]); // only 1 of 2 found
    await expect(
      svc.assign("ws1", { contactIds: ["c1", "foreign"], add: ["VIP"] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe("assign (set-based)", () => {
    const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join("?");

    it("runs one UPDATE per added name inside one transaction with a 30s timeout", async () => {
      prisma.contact.findMany.mockResolvedValue([
        { id: "c1", tags: "[]" },
        { id: "c2", tags: '["Pro"]' },
      ]);
      prisma.tag.findFirst.mockResolvedValue({ id: "t1", name: "VIP", color: "90" });
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: "c1" }, { id: "c2" }]) // VIP
        .mockResolvedValueOnce([{ id: "c1" }]); // Hot
      const res = await svc.assign("ws1", { contactIds: ["c1", "c2"], add: ["VIP", "Hot"] });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][1]).toEqual({ timeout: 30000 });
      expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
      const [first] = tx.$queryRaw.mock.calls;
      const sql = sqlOf(first);
      expect(sql).toContain('UPDATE "Contact"');
      expect(sql).toContain("= ANY(");
      expect(sql).toContain('NOT ("tags"::jsonb ?');
      expect(sql).toContain("RETURNING");
      expect(first).toContainEqual(["c1", "c2"]);
      expect(first).toContain("ws1");
      expect(first).toContain("VIP");
      // No per-contact writes.
      expect(tx.contact.update).not.toHaveBeenCalled();
      expect(prisma.contact.update).not.toHaveBeenCalled();
      // Distinct contacts changed, not name-updates summed.
      expect(res).toEqual({ contactsUpdated: 2 });
    });

    it("runs one UPDATE per removed name that filters the element out", async () => {
      prisma.contact.findMany.mockResolvedValue([{ id: "c1", tags: '["VIP","Pro"]' }]);
      tx.$queryRaw.mockResolvedValueOnce([{ id: "c1" }]);
      const res = await svc.assign("ws1", { contactIds: ["c1"], remove: ["VIP"] });
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      const sql = sqlOf(tx.$queryRaw.mock.calls[0]);
      expect(sql).toContain("jsonb_array_elements");
      expect(sql).toContain('"tags"::jsonb ?');
      expect(sql).not.toContain("NOT (");
      expect(tx.$queryRaw.mock.calls[0]).toContain("VIP");
      expect(prisma.tag.create).not.toHaveBeenCalled();
      expect(res).toEqual({ contactsUpdated: 1 });
    });

    it("removes before adding, so a name in both lists ends up present", async () => {
      prisma.contact.findMany.mockResolvedValue([{ id: "c1", tags: '["VIP"]' }]);
      prisma.tag.findFirst.mockResolvedValue({ id: "t1", name: "VIP", color: "90" });
      await svc.assign("ws1", { contactIds: ["c1"], add: ["VIP"], remove: ["VIP"] });
      const sqls = tx.$queryRaw.mock.calls.map(sqlOf);
      expect(sqls[0]).toContain("jsonb_array_elements");
      expect(sqls[1]).toContain("NOT (");
    });

    it("never casts a malformed tags row: it is reset to the added names instead of 500ing", async () => {
      prisma.contact.findMany.mockResolvedValue([
        { id: "c1", tags: "[]" },
        { id: "bad", tags: "{not json" },
        { id: "obj", tags: '{"a":1}' },
      ]);
      prisma.tag.findFirst.mockResolvedValue({ id: "t1", name: "VIP", color: "90" });
      tx.$queryRaw.mockResolvedValueOnce([{ id: "c1" }]);
      tx.contact.updateMany.mockResolvedValueOnce({ count: 2 });
      const res = await svc.assign("ws1", { contactIds: ["c1", "bad", "obj"], add: ["VIP"] });
      // SQL only ever sees the rows whose tags parsed as a JSON array.
      expect(tx.$queryRaw.mock.calls[0]).toContainEqual(["c1"]);
      expect(tx.contact.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: "ws1", id: { in: ["bad", "obj"] } },
        data: { tags: JSON.stringify(["VIP"]) },
      });
      expect(res).toEqual({ contactsUpdated: 3 });
    });

    it("leaves malformed rows alone on a remove-only call", async () => {
      prisma.contact.findMany.mockResolvedValue([{ id: "bad", tags: "nope" }]);
      const res = await svc.assign("ws1", { contactIds: ["bad"], remove: ["VIP"] });
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.contact.updateMany).not.toHaveBeenCalled();
      expect(res).toEqual({ contactsUpdated: 0 });
    });
  });
});
