import { BadRequestException } from "@nestjs/common";
import { ContactsExportService, EXPORT_PAGE_SIZE, csvCell, unescapeFormulaCell } from "./contacts-export.service";
import { buildContactWhere, parseContactFilter } from "./contact-filter";
import { SegmentsService } from "../segments/segments.service";

const mkRow = (i: number, over: Record<string, unknown> = {}) => ({
  id: `c${String(i).padStart(6, "0")}`,
  name: `Name ${i}`,
  firstName: null,
  lastName: null,
  email: null,
  ownerId: null,
  marketingOptOut: false,
  notALead: false,
  createdAt: new Date(Date.UTC(2026, 0, 1)),
  phone: null,
  industry: "",
  lifecycle: "lead",
  source: "manual",
  value: null,
  lastSeen: "",
  tags: "[]",
  convs: 0,
  ...over,
});

/** The id of the keyset clause `{ OR: [{createdAt<}, {createdAt=, id<}] }` added by the export, if any. */
function keysetLastId(where: unknown): string | undefined {
  const and = (where as { AND?: { OR?: { id?: { lt: string } }[] }[] })?.AND;
  const clause = and?.[and.length - 1]?.OR;
  return clause?.[1]?.id?.lt;
}

function makePrisma(rows: ReturnType<typeof mkRow>[], extra: Record<string, unknown> = {}) {
  // Rows are kept in export order; the keyset clause is the last AND entry.
  const findMany = jest.fn(async (args: { take?: number; where?: unknown }) => {
    let start = 0;
    const last = keysetLastId(args.where);
    if (last) start = rows.findIndex((r) => r.id === last) + 1;
    return rows.slice(start, start + (args.take as number));
  });
  return {
    contact: { findMany },
    customFieldDef: { findMany: jest.fn().mockResolvedValue([]) },
    customFieldValue: { findMany: jest.fn().mockResolvedValue([]) },
    workspaceMember: { findMany: jest.fn().mockResolvedValue([]) },
    segment: { findFirst: jest.fn() },
    ...extra,
  };
}

async function exportAll(
  prisma: ReturnType<typeof makePrisma>,
  filter = {},
  ids?: string[],
  collect = true,
) {
  const svc = new ContactsExportService(prisma as never, new SegmentsService(prisma as never));
  const job = await svc.prepare("ws1", filter, ids);
  const chunks: string[] = [];
  let size = 0;
  const res = await job.run({
    aborted: () => false,
    write: (c) => {
      size += c.length;
      if (collect) chunks.push(c);
    },
  });
  return { text: chunks.join(""), chunks, size, ...res, job };
}

describe("csvCell", () => {
  it("escapes quotes, commas and newlines (RFC4180)", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("l1\nl2")).toBe('"l1\nl2"');
    expect(csvCell("l1\r\nl2")).toBe('"l1\r\nl2"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
  });
});

describe("ContactsExportService", () => {
  it("writes BOM, the exact header, custom-field labels and tags joined with ', '", async () => {
    const prisma = makePrisma([mkRow(1, { tags: JSON.stringify(["VIP", "Riyadh, KSA"]), ownerId: "u1" })]);
    prisma.customFieldDef.findMany.mockResolvedValue([
      { id: "d1", label: "Budget", type: "number" },
      { id: "d2", label: "VIP?", type: "boolean" },
    ]);
    prisma.customFieldValue.findMany.mockResolvedValue([{ contactId: "c000001", defId: "d1", value: 5000 }]);
    prisma.workspaceMember.findMany.mockResolvedValue([{ userId: "u1", user: { name: "Owner One", email: "o@x.io" } }]);
    const { text, job } = await exportAll(prisma);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe(
      "id,firstName,lastName,name,phone,email,lifecycle,tags,owner,source,industry,value,marketingOptOut,notALead,createdAt,Budget,VIP?",
    );
    expect(lines[1]).toBe(
      'c000001,Name,1,Name 1,,,lead,"VIP, Riyadh, KSA",o@x.io,manual,,,false,false,2026-01-01T00:00:00.000Z,5000,',
    );
    expect(job.filename).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.csv$/);
    // Defs: non-archived, ordered, workspace-scoped.
    expect(prisma.customFieldDef.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws1", entity: "contact", archivedAt: null },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      }),
    );
  });

  it("keeps paging when the last row of a page is deleted mid-export (keyset, no cursor)", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => mkRow(2499 - i)); // export order: id desc
    const live = [...rows];
    const prisma = makePrisma(rows);
    prisma.contact.findMany.mockImplementation(async (args: { take?: number; where?: unknown }) => {
      const last = keysetLastId(args.where);
      const list = last ? live.filter((r) => r.id < last) : live;
      const page = list.slice(0, args.take as number);
      // another user deletes the last row of the first page right after it was read
      if (!last) live.splice(live.indexOf(page[page.length - 1]), 1);
      return page;
    });
    const { text, rows: count } = await exportAll(prisma);
    expect(count).toBe(2500); // the deleted row was already read; paging continues past it
    expect(text).toContain("c001499");
    expect(text).toContain("c000000");
    for (const [a] of prisma.contact.findMany.mock.calls) expect(a).not.toHaveProperty("cursor");
  });

  it("disambiguates custom-field headers that collide with base columns or each other", async () => {
    const prisma = makePrisma([mkRow(1)]);
    prisma.customFieldDef.findMany.mockResolvedValue([
      { id: "d1", key: "nm", label: "Name", type: "text" },
      { id: "d2", key: "a", label: "Plan", type: "text" },
      { id: "d3", key: "b", label: "plan", type: "text" },
      { id: "d4", key: "c", label: "Budget", type: "text" },
      { id: "d5", key: "v", label: "Value", type: "text" },
    ]);
    const { text } = await exportAll(prisma);
    const header = text.slice(1).split("\r\n")[0].split(",");
    expect(header.slice(-5)).toEqual(["Name (nm)", "Plan (a)", "plan (b)", "Budget", "Value (v)"]);
    expect(new Set(header.map((h) => h.toLowerCase())).size).toBe(header.length);
  });

  it("escapes quotes, commas and newlines inside real rows", async () => {
    const prisma = makePrisma([mkRow(1, { name: 'Ali "Abu" Said, Jr', industry: "line1\nline2" })]);
    const { text } = await exportAll(prisma);
    expect(text).toContain('"Ali ""Abu"" Said, Jr"');
    expect(text).toContain('"line1\nline2"');
  });

  it("streams 100k rows by cursor: every findMany has take, never the full set at once", async () => {
    const N = 100_000;
    const rows = Array.from({ length: N }, (_, i) => mkRow(i));
    const prisma = makePrisma(rows);
    const { size, rows: count, chunks } = await exportAll(prisma, {}, undefined, false);
    expect(count).toBe(N);
    const calls = prisma.contact.findMany.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls.length).toBe(N / EXPORT_PAGE_SIZE + 1); // last page is full, so one extra empty probe
    for (const a of calls) expect(a.take).toBe(EXPORT_PAGE_SIZE);
    expect(calls[0].cursor).toBeUndefined();
    expect(calls[0].where).toEqual({ workspaceId: "ws1" });
    expect(calls[1].cursor).toBeUndefined();
    expect(calls[1].where).toEqual({
      AND: [
        { workspaceId: "ws1" },
        {
          OR: [
            { createdAt: { lt: rows[EXPORT_PAGE_SIZE - 1].createdAt } },
            { createdAt: rows[EXPORT_PAGE_SIZE - 1].createdAt, id: { lt: rows[EXPORT_PAGE_SIZE - 1].id } },
          ],
        },
      ],
    });
    expect(size).toBeGreaterThan(N * 10);
    expect(chunks).toHaveLength(0); // sink received data piecewise, nothing buffered by the service
  });

  it("stops the cursor loop when the client aborts", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => mkRow(i));
    const prisma = makePrisma(rows);
    const svc = new ContactsExportService(prisma as never, new SegmentsService(prisma as never));
    const job = await svc.prepare("ws1", {});
    let writes = 0;
    await job.run({ aborted: () => writes >= 2, write: () => void writes++ }); // header + page 1
    expect(prisma.contact.findMany).toHaveBeenCalledTimes(1);
  });

  it("uses exactly the /contacts/page where (filter parity)", async () => {
    const prisma = makePrisma([mkRow(1)]);
    const filter = parseContactFilter({ q: "sara", lifecycle: "lead,customer", tags: '["VIP"]', ownerId: "none", optOut: "true" });
    await exportAll(prisma, filter);
    const expected = await buildContactWhere("ws1", filter, {
      prisma: prisma as never,
      segments: new SegmentsService(prisma as never),
    });
    expect((prisma.contact.findMany.mock.calls[0][0] as { where: unknown }).where).toEqual(expected);
  });

  it("narrows by ids inside the workspace-scoped where; rejects more than 10 000", async () => {
    const prisma = makePrisma([mkRow(1)]);
    await exportAll(prisma, {}, ["c000001", "foreign"]);
    const where = (prisma.contact.findMany.mock.calls[0][0] as { where: { AND: unknown[] } }).where;
    expect(where).toEqual({ AND: [{ workspaceId: "ws1" }, { id: { in: ["c000001", "foreign"] } }] });

    const svc = new ContactsExportService(prisma as never, new SegmentsService(prisma as never));
    const tooMany = Array.from({ length: 10_001 }, (_, i) => `x${i}`);
    await expect(svc.prepare("ws1", {}, tooMany)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("looks custom values up only for the page's contacts and the workspace's defs", async () => {
    const prisma = makePrisma([mkRow(1), mkRow(2)]);
    prisma.customFieldDef.findMany.mockResolvedValue([{ id: "d1", label: "L", type: "text" }]);
    await exportAll(prisma);
    expect(prisma.customFieldValue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contactId: { in: ["c000001", "c000002"] }, defId: { in: ["d1"] } } }),
    );
  });
});

describe("formula neutralisation", () => {
  it("prefixes = + - @ tab CR with an apostrophe before quoting", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+971501234567")).toBe("'+971501234567");
    expect(csvCell("-VIP")).toBe("'-VIP");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell("	x")).toBe("'	x");
    expect(csvCell('=A1,"b"')).toBe(`"'=A1,""b"""`);
    expect(csvCell("safe=1")).toBe("safe=1");
  });
  it("unescapeFormulaCell only strips before a trigger char", () => {
    expect(unescapeFormulaCell("'=A1")).toBe("=A1");
    expect(unescapeFormulaCell("'+9")).toBe("+9");
    expect(unescapeFormulaCell("'hello")).toBe("'hello");
    expect(unescapeFormulaCell("'")).toBe("'");
    expect(unescapeFormulaCell("=A1")).toBe("=A1");
  });
});
