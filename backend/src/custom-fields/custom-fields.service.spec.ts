import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CustomFieldsService, fieldWhere } from "./custom-fields.service";

describe("CustomFieldsService", () => {
  let prisma: any;
  let svc: CustomFieldsService;
  const WS = "ws1";

  const def = (over: Record<string, unknown> = {}) => ({
    id: "d1",
    workspaceId: WS,
    entity: "contact",
    key: "k",
    label: "K",
    labelAr: "ك",
    type: "text",
    options: null,
    order: 0,
    archivedAt: null,
    ...over,
  });

  beforeEach(() => {
    prisma = {
      customFieldDef: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        create: jest.fn(async ({ data }: any) => ({ id: "new", ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      customFieldValue: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        upsert: jest.fn((a: any) => ({ op: "upsert", ...a })),
        deleteMany: jest.fn((a: any) => ({ op: "delete", ...a })),
      },
      contact: { findFirst: jest.fn().mockResolvedValue({ id: "c1" }) },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
    };
    svc = new CustomFieldsService(prisma as never);
  });

  it("creates select field with options; rejects select without options", async () => {
    const r = await svc.create(WS, {
      label: "Plan",
      labelAr: "خطة",
      type: "select",
      options: [" gold ", "silver"],
    });
    expect(r.options).toEqual(["gold", "silver"]);
    expect(r.key).toBe("plan");
    await expect(svc.create(WS, { label: "X", labelAr: "x", type: "select" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      svc.create(WS, { label: "X", labelAr: "x", type: "select", options: ["a", "a"] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("key slug unique with suffix", async () => {
    prisma.customFieldDef.findMany.mockResolvedValue([{ key: "vip_level" }, { key: "vip_level_2" }]);
    const r = await svc.create(WS, { label: "VIP Level!", labelAr: "x", type: "text" });
    expect(r.key).toBe("vip_level_3");
    const a = await svc.create(WS, { label: "مستوى", labelAr: "مستوى", type: "text" });
    expect(a.key).toBe("field_3");
  });

  it("type is immutable", async () => {
    prisma.customFieldDef.findFirst.mockResolvedValue(def());
    await expect(svc.update(WS, "d1", { type: "number" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("delete-custom-field-with-references archives and keeps values", async () => {
    prisma.customFieldDef.findFirst.mockResolvedValue(def());
    prisma.customFieldValue.count.mockResolvedValue(7);
    expect(await svc.deletePreview(WS, "d1")).toEqual({ valueCount: 7 });
    const r = await svc.remove(WS, "d1");
    expect(r).toEqual({ ok: true, valueCount: 7 });
    const call = prisma.customFieldDef.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "d1", workspaceId: WS });
    expect(call.data.archivedAt).toBeInstanceOf(Date);
    expect(prisma.customFieldValue.deleteMany).not.toHaveBeenCalled();
  });

  describe("put", () => {
    const put = async (d: Record<string, unknown>, value: unknown) => {
      prisma.customFieldDef.findMany.mockImplementation(async (a: any) =>
        a.where?.id ? [def(d)] : [],
      );
      return svc.setForContact(WS, "c1", { d1: value });
    };
    const stored = () => prisma.customFieldValue.upsert.mock.calls[0][0].create.value;

    it("put validates by type", async () => {
      await put({ type: "text" }, "hello");
      expect(stored()).toBe("hello");
      await expect(put({ type: "text" }, 5)).rejects.toBeInstanceOf(BadRequestException);
      await expect(put({ type: "text" }, "x".repeat(2001))).rejects.toBeInstanceOf(BadRequestException);

      await expect(put({ type: "number" }, "abc")).rejects.toBeInstanceOf(BadRequestException);
      await expect(put({ type: "number" }, Infinity)).rejects.toBeInstanceOf(BadRequestException);

      await expect(put({ type: "date" }, "2026-02-30")).rejects.toBeInstanceOf(BadRequestException);
      await expect(put({ type: "date" }, "08/11/2026")).rejects.toBeInstanceOf(BadRequestException);
      prisma.customFieldValue.upsert.mockClear();
      await put({ type: "date" }, "2026-11-08");
      expect(stored()).toBe("2026-11-08");

      prisma.customFieldValue.upsert.mockClear();
      await put({ type: "select", options: ["a", "b"] }, "b");
      expect(stored()).toBe("b");
      await expect(put({ type: "select", options: ["a", "b"] }, "c")).rejects.toBeInstanceOf(
        BadRequestException,
      );

      prisma.customFieldValue.upsert.mockClear();
      await put({ type: "boolean" }, false);
      expect(stored()).toBe(false);
      await expect(put({ type: "boolean" }, "true")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("number accepts Arabic-Indic digits", async () => {
      await put({ type: "number" }, "١٢٣");
      expect(stored()).toBe(123);
    });

    it("null deletes value", async () => {
      await put({ type: "text" }, null);
      expect(prisma.customFieldValue.deleteMany).toHaveBeenCalledWith({
        where: { defId: "d1", contactId: "c1" },
      });
      expect(prisma.customFieldValue.upsert).not.toHaveBeenCalled();
    });

    it("archived def → 404 on put", async () => {
      prisma.customFieldDef.findMany.mockImplementation(async (a: any) =>
        a.where?.archivedAt === null ? [] : [],
      );
      await expect(svc.setForContact(WS, "c1", { d1: "x" })).rejects.toBeInstanceOf(NotFoundException);
      const q = prisma.customFieldDef.findMany.mock.calls[0][0];
      expect(q.where).toMatchObject({ workspaceId: WS, archivedAt: null });
    });

    it("foreign contact → 404", async () => {
      prisma.contact.findFirst.mockResolvedValue(null);
      await expect(svc.setForContact(WS, "cX", { d1: "x" })).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.getForContact(WS, "cX")).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.contact.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "cX", workspaceId: WS } }),
      );
      expect(prisma.customFieldValue.upsert).not.toHaveBeenCalled();
    });
  });

  it("fieldWhere builds expected where for each type", () => {
    const w = (v: unknown) => ({ fieldValues: { some: { defId: "d", value: v } } });
    expect(fieldWhere({ id: "d", type: "text" }, "eq", "a")).toEqual(w({ equals: "a" }));
    expect(fieldWhere({ id: "d", type: "text" }, "contains", "a")).toEqual(w({ string_contains: "a" }));
    expect(fieldWhere({ id: "d", type: "select" }, "eq", "a")).toEqual(w({ equals: "a" }));
    expect(fieldWhere({ id: "d", type: "boolean" }, "eq", "true")).toEqual(w({ equals: true }));
    expect(fieldWhere({ id: "d", type: "number" }, "gt", "١٠")).toEqual(w({ gt: 10 }));
    expect(fieldWhere({ id: "d", type: "number" }, "lt", "5")).toEqual(w({ lt: 5 }));
    expect(fieldWhere({ id: "d", type: "number" }, "eq", "5")).toEqual(w({ equals: 5 }));
    expect(fieldWhere({ id: "d", type: "date" }, "gt", "2026-01-01")).toEqual(w({ gt: "2026-01-01" }));
    expect(fieldWhere({ id: "d", type: "date" }, "eq", "2026-01-01")).toEqual(w({ equals: "2026-01-01" }));
    expect(fieldWhere({ id: "d", type: "date" }, "set")).toEqual({ fieldValues: { some: { defId: "d" } } });
    expect(fieldWhere({ id: "d", type: "text" }, "unset")).toEqual({ fieldValues: { none: { defId: "d" } } });
    expect(() => fieldWhere({ id: "d", type: "boolean" }, "gt", "1")).toThrow(BadRequestException);
    expect(() => fieldWhere({ id: "d", type: "number" }, "gt", "abc")).toThrow(BadRequestException);
  });
});
