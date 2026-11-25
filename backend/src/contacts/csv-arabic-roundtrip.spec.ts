import { ContactsExportService } from "./contacts-export.service";
import { SegmentsService } from "../segments/segments.service";
import { parseFile } from "../imports/parse-file";

/** Review Focus 2: Arabic names and tags survive export -> parse unchanged. */
describe("contacts CSV Arabic round-trip", () => {
  it("re-parses to the same values, BOM present", async () => {
    const rows = [
      {
        id: "c1",
        name: "محمد الأحمد",
        firstName: "محمد",
        lastName: "الأحمد",
        email: "m@x.io",
        ownerId: "u1",
        marketingOptOut: false,
        notALead: true,
        createdAt: new Date("2026-02-03T04:05:06.000Z"),
        phone: "+966501234567",
        industry: "عقارات",
        lifecycle: "customer",
        source: "واتساب",
        value: null,
        lastSeen: "",
        tags: JSON.stringify(["عميل مميز", "الرياض، السعودية", 'قال "مرحبا"', "a,b"]),
        convs: 0,
      },
      {
        id: "c2",
        name: "=HYPERLINK(\"http://evil\",\"سارة\")",
        firstName: null,
        lastName: null,
        email: null,
        ownerId: null,
        marketingOptOut: true,
        notALead: false,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        phone: null,
        industry: "",
        lifecycle: "lead",
        source: "manual",
        value: null,
        lastSeen: "",
        tags: JSON.stringify(["-VIP", "@عميل", "+tag"]),
        convs: 0,
      },
    ];
    const prisma = {
      contact: { findMany: jest.fn().mockResolvedValueOnce(rows) },
      customFieldDef: { findMany: jest.fn().mockResolvedValue([{ id: "d1", label: "ملاحظات\nالعميل", type: "text" }]) },
      customFieldValue: {
        findMany: jest.fn().mockResolvedValue([{ contactId: "c1", defId: "d1", value: "سطر 1\nسطر 2, \"اقتباس\"" }]),
      },
      workspaceMember: { findMany: jest.fn().mockResolvedValue([{ userId: "u1", user: { name: "أحمد المدير", email: "a@x.io" } }]) },
    };
    const svc = new ContactsExportService(prisma as never, new SegmentsService(prisma as never));
    const job = await svc.prepare("ws1", {});
    const parts: string[] = [];
    await job.run({ aborted: () => false, write: (c) => void parts.push(c) });
    const text = parts.join("");
    const buf = Buffer.from(text, "utf8");
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const parsed = await parseFile(buf, "contacts.csv");
    const col = (h: string) => parsed.headers.indexOf(h);
    expect(parsed.rows).toHaveLength(2);
    const [r1, r2] = parsed.rows;
    expect(r1[col("name")]).toBe("محمد الأحمد");
    expect(r1[col("firstName")]).toBe("محمد");
    expect(r1[col("lastName")]).toBe("الأحمد");
    expect(r1[col("industry")]).toBe("عقارات");
    expect(r1[col("source")]).toBe("واتساب");
    expect(r1[col("owner")]).toBe("a@x.io");
    expect(r1[col("tags")]).toBe('عميل مميز, الرياض، السعودية, قال "مرحبا", a,b');
    expect(r1[col("phone")]).toBe("+966501234567");
    expect(r1[col("notALead")]).toBe("true");
    expect(r1[col("ملاحظات\nالعميل")]).toBe('سطر 1\nسطر 2, "اقتباس"');
    expect(r2[col("name")]).toBe('=HYPERLINK("http://evil","سارة")');
    expect(r2[col("tags")]).toBe("-VIP, @عميل, +tag");
    expect(text).toContain("'=HYPERLINK(");
    expect(text).toContain("'+966501234567");
    expect(r2[col("marketingOptOut")]).toBe("true");
  });
});
