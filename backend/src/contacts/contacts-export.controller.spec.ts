import { EventEmitter } from "events";
import { ContactsController } from "./contacts.controller";
import { ContactsExportService } from "./contacts-export.service";
import { SegmentsService } from "../segments/segments.service";

class FakeRes extends EventEmitter {
  headers: Record<string, string> = {};
  chunks: string[] = [];
  statusCode = 0;
  headersSent = false;
  writableEnded = false;
  ended = false;
  /** Simulate the client disconnecting after this many writes. */
  abortAfter = Infinity;
  status(c: number) { this.statusCode = c; return this; }
  setHeader(k: string, v: string) { this.headers[k] = v; }
  write(c: string) {
    this.headersSent = true;
    this.chunks.push(c);
    if (this.chunks.length >= this.abortAfter) this.emit("close");
    return true;
  }
  end() { this.ended = true; this.writableEnded = true; this.emit("close"); }
  destroy() {}
}

const row = (i: number) => ({
  id: `c${String(i).padStart(5, "0")}`, name: `N${i}`, firstName: null, lastName: null, email: null, ownerId: null,
  marketingOptOut: false, notALead: false, createdAt: new Date(0), phone: null, industry: "", lifecycle: "lead",
  source: "manual", value: null, lastSeen: "", tags: "[]", convs: 0,
});

function setup(rows: ReturnType<typeof row>[]) {
  const prisma = {
    contact: {
      findMany: jest.fn(async (a: { take: number; where?: { AND?: { OR?: { id?: { lt: string } }[] }[] } }) => {
        const and = a.where?.AND;
        const last = and?.[and.length - 1]?.OR?.[1]?.id?.lt;
        const start = last ? rows.findIndex((r) => r.id === last) + 1 : 0;
        return rows.slice(start, start + a.take);
      }),
    },
    customFieldDef: { findMany: jest.fn().mockResolvedValue([]) },
    customFieldValue: { findMany: jest.fn().mockResolvedValue([]) },
    workspaceMember: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const exp = new ContactsExportService(prisma as never, new SegmentsService(prisma as never));
  return { prisma, ctrl: new ContactsController({} as never, {} as never, exp, {} as never, {} as never) };
}

describe("ContactsController.export streaming", () => {
  it("sets headers, writes BOM first, streams rows, then ends", async () => {
    const { ctrl } = setup([row(1), row(2)]);
    const res = new FakeRes();
    await ctrl.export("ws1", {}, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["Content-Disposition"]).toMatch(/^attachment; filename="contacts-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.chunks[0].charCodeAt(0)).toBe(0xfeff);
    expect(res.chunks.join("")).toContain("c00001");
    expect(res.chunks.join("")).toContain("c00002");
    expect(res.ended).toBe(true);
  });

  it("parses ids and stops fetching pages when the client aborts", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row(i));
    const { ctrl, prisma } = setup(rows);
    const res = new FakeRes();
    res.abortAfter = 2; // header + first page, then the client goes away
    await ctrl.export("ws1", {}, res as never);
    expect(prisma.contact.findMany).toHaveBeenCalledTimes(1);
    expect(res.ended).toBe(false);

    const { ctrl: c2, prisma: p2 } = setup([row(1)]);
    await c2.export("ws1", { ids: " a, b ,a" }, new FakeRes() as never);
    expect((p2.contact.findMany.mock.calls[0][0] as unknown as { where: unknown }).where).toEqual({
      AND: [{ workspaceId: "ws1" }, { id: { in: ["a", "b"] } }],
    });
  });

  it("POST export takes ids in the JSON body (no URL limit) and streams the same CSV", async () => {
    const { ctrl, prisma } = setup([row(1), row(2)]);
    const ids = Array.from({ length: 5000 }, (_, i) => `id${i}`);
    const res = new FakeRes();
    await ctrl.exportPost("ws1", { ids, lifecycle: "lead" }, res as never);
    expect(res.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(res.ended).toBe(true);
    const where = (prisma.contact.findMany.mock.calls[0][0] as unknown as { where: { AND: unknown[] } }).where;
    expect(where.AND[1]).toEqual({ id: { in: ids } });
    expect(JSON.stringify(where.AND[0])).toContain("lead");
  });

  it("POST export with only a filter exports by filter; rejects bad or oversized ids", async () => {
    const { ctrl, prisma } = setup([row(1)]);
    await ctrl.exportPost("ws1", { q: "sara" }, new FakeRes() as never);
    const where = (prisma.contact.findMany.mock.calls[0][0] as unknown as { where: { AND?: unknown[] } }).where;
    expect(JSON.stringify(where)).toContain("sara");
    expect(JSON.stringify(where)).not.toContain('"id":{"in"');
    await expect(ctrl.exportPost("ws1", { ids: "a,b" }, new FakeRes() as never)).rejects.toThrow("ids must be an array");
    const big = Array.from({ length: 10_001 }, (_, i) => `x${i}`);
    await expect(ctrl.exportPost("ws1", { ids: big }, new FakeRes() as never)).rejects.toThrow("limited to 10000");
  });
});
