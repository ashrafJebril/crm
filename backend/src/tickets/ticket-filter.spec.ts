import { BadRequestException } from "@nestjs/common";
import {
  buildTicketWhere,
  decodeCursor,
  encodeCursor,
  ticketCursorWhere,
  ticketOrderBy,
} from "./ticket-filter";

describe("buildTicketWhere", () => {
  it("always scopes to the workspace", () => {
    expect(buildTicketWhere("ws1", {}, "Asia/Riyadh")).toEqual({ workspaceId: "ws1" });
  });

  it("passes through pipeline/stage/contact/conversation filters", () => {
    const w = buildTicketWhere("ws1", { pipelineId: "p", stageId: "s", contactId: "c", conversationId: "cv" }, "UTC");
    expect(w).toMatchObject({ workspaceId: "ws1", pipelineId: "p", stageId: "s", contactId: "c", conversationId: "cv" });
  });

  it("ownerId filters by user id, and 'none' means unassigned", () => {
    expect(buildTicketWhere("ws1", { ownerId: "u1" }, "UTC").ownerId).toBe("u1");
    expect(buildTicketWhere("ws1", { ownerId: "none" }, "UTC").ownerId).toBeNull();
  });

  it("status maps to the stage flags", () => {
    expect(buildTicketWhere("ws1", { status: "open" }, "UTC").stage).toEqual({ isTerminal: false });
    expect(buildTicketWhere("ws1", { status: "won" }, "UTC").stage).toEqual({ isTerminal: true, isWon: true });
    expect(buildTicketWhere("ws1", { status: "lost" }, "UTC").stage).toEqual({ isTerminal: true, isWon: false });
  });

  it("rejects an unknown status", () => {
    expect(() => buildTicketWhere("ws1", { status: "weird" as never }, "UTC")).toThrow(BadRequestException);
  });

  it("q searches the title and the contact name", () => {
    const w = buildTicketWhere("ws1", { q: "  acme " }, "UTC");
    expect(w.OR).toEqual([
      { title: { contains: "acme", mode: "insensitive" } },
      { contact: { name: { contains: "acme", mode: "insensitive" } } },
    ]);
  });

  it("a numeric q (optionally #-prefixed) also matches the ticket number", () => {
    expect(buildTicketWhere("ws1", { q: "#42" }, "UTC").OR).toContainEqual({ number: 42 });
    expect(buildTicketWhere("ws1", { q: "7" }, "UTC").OR).toContainEqual({ number: 7 });
    expect(buildTicketWhere("ws1", { q: "acme1" }, "UTC").OR).toHaveLength(2);
  });

  it("from/to are correct in UTC+12 zones (Pacific/Auckland, NZST in June)", () => {
    const w = buildTicketWhere("ws1", { from: "2026-06-10", to: "2026-06-10" }, "Pacific/Auckland");
    expect(w.createdAt).toEqual({
      gte: new Date("2026-06-09T12:00:00.000Z"),
      lt: new Date("2026-06-10T12:00:00.000Z"),
    });
  });

  it("a blank q is ignored", () => {
    expect(buildTicketWhere("ws1", { q: "   " }, "UTC").OR).toBeUndefined();
  });

  it("from/to are inclusive local days (Riyadh = UTC+3)", () => {
    const w = buildTicketWhere("ws1", { from: "2026-03-10", to: "2026-03-12" }, "Asia/Riyadh");
    // local midnight of the 10th = 21:00Z on the 9th; end is exclusive midnight after the 12th
    expect(w.createdAt).toEqual({
      gte: new Date("2026-03-09T21:00:00.000Z"),
      lt: new Date("2026-03-12T21:00:00.000Z"),
    });
  });

  it("only from, or only to, gives a half-open range", () => {
    expect(buildTicketWhere("ws1", { from: "2026-03-10" }, "UTC").createdAt).toEqual({
      gte: new Date("2026-03-10T00:00:00.000Z"),
    });
    expect(buildTicketWhere("ws1", { to: "2026-03-10" }, "UTC").createdAt).toEqual({
      lt: new Date("2026-03-11T00:00:00.000Z"),
    });
  });

  it("a ticket at 23:30 local on the 'to' day is included, 00:00 next day is not", () => {
    const w = buildTicketWhere("ws1", { to: "2026-03-12" }, "Asia/Riyadh");
    const lt = (w.createdAt as { lt: Date }).lt;
    expect(new Date("2026-03-12T20:30:00.000Z").getTime()).toBeLessThan(lt.getTime()); // 23:30 local
    expect(new Date("2026-03-12T21:00:00.000Z").getTime()).toBeGreaterThanOrEqual(lt.getTime()); // 00:00 local next day
  });

  it("rejects malformed dates", () => {
    expect(() => buildTicketWhere("ws1", { from: "10/03/2026" }, "UTC")).toThrow(BadRequestException);
    expect(() => buildTicketWhere("ws1", { to: "2026-13-45" }, "UTC")).toThrow(BadRequestException);
  });

  it("table and kanban share one builder: same filters, same where", () => {
    const f = { pipelineId: "p", ownerId: "none", status: "open" as const, q: "x", from: "2026-01-01" };
    expect(buildTicketWhere("ws1", f, "UTC")).toEqual(buildTicketWhere("ws1", { ...f, stageId: undefined }, "UTC"));
  });
});

describe("ordering and cursors", () => {
  it("orders by the sort field then id in the same direction", () => {
    expect(ticketOrderBy("createdAt", "desc")).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(ticketOrderBy("enteredStageAt", "asc")).toEqual([{ enteredStageAt: "asc" }, { id: "asc" }]);
  });

  it("value sorts nulls last in both directions", () => {
    expect(ticketOrderBy("value", "asc")[0]).toEqual({ value: { sort: "asc", nulls: "last" } });
    expect(ticketOrderBy("value", "desc")[0]).toEqual({ value: { sort: "desc", nulls: "last" } });
  });

  it("cursor round-trips dates, numbers and null", () => {
    const d = new Date("2026-03-10T10:00:00.000Z");
    expect(decodeCursor(encodeCursor("createdAt", { createdAt: d, id: "t1" }), "createdAt")).toEqual({ v: d, id: "t1" });
    expect(decodeCursor(encodeCursor("value", { value: 12.5, id: "t2" }), "value")).toEqual({ v: 12.5, id: "t2" });
    expect(decodeCursor(encodeCursor("value", { value: null, id: "t3" }), "value")).toEqual({ v: null, id: "t3" });
  });

  it("a garbage cursor is a 400", () => {
    expect(() => decodeCursor("%%%", "createdAt")).toThrow(BadRequestException);
  });

  it("keyset where for a date field, desc: strictly before, or equal with a smaller id", () => {
    const d = new Date("2026-03-10T10:00:00.000Z");
    expect(ticketCursorWhere("createdAt", "desc", { v: d, id: "t5" })).toEqual({
      OR: [{ createdAt: { lt: d } }, { createdAt: d, id: { lt: "t5" } }],
    });
  });

  it("keyset where for value with a number includes the null tail", () => {
    expect(ticketCursorWhere("value", "asc", { v: 10, id: "t5" })).toEqual({
      OR: [{ value: { gt: 10 } }, { value: 10, id: { gt: "t5" } }, { value: null }],
    });
  });

  it("keyset where for a null value cursor continues inside the null tail", () => {
    expect(ticketCursorWhere("value", "desc", { v: null, id: "t5" })).toEqual({ value: null, id: { lt: "t5" } });
  });

  it("paging with ties never skips or repeats a row (simulated store)", () => {
    // Rows share createdAt; walk the keyset pages and compare with the full order.
    const t = new Date("2026-03-10T10:00:00.000Z");
    const rows = ["a", "b", "c", "d", "e"].map((id) => ({ id, createdAt: t }));
    const sorted = [...rows].sort((x, y) => (x.id < y.id ? 1 : -1)); // desc
    const seen: string[] = [];
    let cur: { v: Date; id: string } | null = null;
    for (;;) {
      const w: any = cur ? ticketCursorWhere("createdAt", "desc", cur) : null;
      const page = sorted
        .filter((r) => !w || r.createdAt < w.OR[0].createdAt.lt || (+r.createdAt === +t && r.id < w.OR[1].id.lt))
        .slice(0, 2);
      if (!page.length) break;
      seen.push(...page.map((r) => r.id));
      cur = { v: page[page.length - 1].createdAt, id: page[page.length - 1].id };
    }
    expect(seen).toEqual(["e", "d", "c", "b", "a"]);
  });
});
