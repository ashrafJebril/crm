import { NotFoundException } from "@nestjs/common";
import { CustomerThreadService } from "./customer-thread.service";

type Row = Record<string, any>;
const ts = (s: string) => new Date(s);
const NOW = new Date("2026-11-11T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

function cmp(v: any, c: any): boolean {
  if (c === null) return v == null;
  if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
  if (typeof c === "object" && !Array.isArray(c)) {
    return Object.entries<any>(c).every(([op, x]) => {
      const t = (y: any) => (y instanceof Date ? y.getTime() : y);
      if (op === "in") return x.includes(v);
      if (op === "lt") return v != null && t(v) < t(x);
      if (op === "lte") return v != null && t(v) <= t(x);
      if (op === "not") return x === null ? v != null : v !== x;
      return true;
    });
  }
  return v === c;
}

class Fake {
  contacts: Row[] = [{ id: "c1", workspaceId: "ws" }];
  conversations: Row[] = [];
  messages: Row[] = [];
  tickets: Row[] = [{ id: "t1", contactId: "c1", workspaceId: "ws", number: 7, title: "Deal", pipelineId: "p1", stage: { key: "b" } }];
  ticketActivities: Row[] = [];
  stages: Row[] = [
    { key: "a", pipelineId: "p1", workspaceId: "ws", label: "Alpha", labelAr: "ألفا" },
    { key: "b", pipelineId: "p1", workspaceId: "ws", label: "Beta", labelAr: "بيتا" },
  ];
  appointments: Row[] = [];
  activities: Row[] = [];

  private match(row: Row, where: Row, rel: (k: string, r: Row, w: Row) => boolean = () => true): boolean {
    return Object.entries<any>(where).every(([k, c]) => {
      if (k === "OR") return c.some((w: Row) => this.match(row, w, rel));
      if (k === "AND") return c.every((w: Row) => this.match(row, w, rel));
      if (k === "conversation" || k === "ticket") return rel(k, row, c);
      return cmp(row[k], c);
    });
  }
  private find(rows: Row[], args: Row, field = "createdAt", rel?: (k: string, r: Row, w: Row) => boolean) {
    let out = rows.filter((r) => this.match(r, args.where ?? {}, rel));
    out = out.sort((a, b) => b[field] - a[field] || (a.id < b.id ? 1 : -1));
    return out.slice(0, args.take ?? out.length);
  }
  private convRel = (_k: string, r: Row, w: Row) => {
    const conv = this.conversations.find((c) => c.id === r.conversationId);
    return !!conv && this.match(conv, w);
  };
  private ticketRel = (_k: string, r: Row, w: Row) => {
    const t = this.tickets.find((x) => x.id === r.ticketId);
    return !!t && this.match(t, w);
  };

  contact = { findFirst: jest.fn(async ({ where }: any) => this.contacts.find((c) => this.match(c, where)) ?? null) };
  conversation = {
    findFirst: jest.fn(async ({ where }: any) => this.conversations.find((c) => this.match(c, where)) ?? null),
    findMany: jest.fn(async ({ where }: any) => this.conversations.filter((c) => this.match(c, where))),
  };
  message = {
    findMany: jest.fn(async (a: any) =>
      this.find(this.messages, a, "createdAt", this.convRel).map((m) => ({
        ...m,
        conversation: this.conversations.find((c) => c.id === m.conversationId),
      })),
    ),
    findFirst: jest.fn(async (a: any) => {
      const rows = this.messages.filter((m) => this.match(m, a.where));
      rows.sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
      return rows[0] ?? null;
    }),
  };
  ticketActivity = {
    findMany: jest.fn(async (a: any) =>
      this.find(this.ticketActivities, a, "createdAt", this.ticketRel).map((t) => ({
        ...t,
        ticket: this.tickets.find((x) => x.id === t.ticketId),
      })),
    ),
    findFirst: jest.fn(async (a: any) => this.find(this.ticketActivities, { ...a, take: 1 })[0] ?? null),
  };
  ticketStage = { findMany: jest.fn(async ({ where }: any) => this.stages.filter((s) => this.match(s, where))) };
  appointment = {
    findMany: jest.fn(async (a: any) => {
      const field = a.orderBy?.[0] && "statusChangedAt" in a.orderBy[0] ? "statusChangedAt" : "createdAt";
      return this.find(this.appointments, a, field);
    }),
  };
  activity = { findMany: jest.fn(async (a: any) => this.find(this.activities, a, "doneAt")) };
}

function build(f: Fake, scope: Row = {}, granted?: string[]) {
  const perm = {
    viewerCan: jest.fn(async (_w: string, _v: unknown, p: string) => !granted || granted.includes(p)),
    conversationScope: jest.fn(async () => scope),
  };
  return new CustomerThreadService(f as never, perm as never);
}

const viewer = { userId: "u1" };

function seed(f: Fake) {
  f.conversations = [
    { id: "v1", contactId: "c1", workspaceId: "ws", channel: "whatsapp", assigneeId: "u1" },
    { id: "v2", contactId: "c1", workspaceId: "ws", channel: "instagram", assigneeId: "u1" },
    { id: "v3", contactId: "c1", workspaceId: "ws", channel: "whatsapp", assigneeId: "u1" },
  ];
  f.messages = [
    { id: "m1", workspaceId: "ws", conversationId: "v1", from: "them", body: "one", createdAt: ts("2026-01-01T10:00:00Z") },
    { id: "m2", workspaceId: "ws", conversationId: "v1", from: "human", body: "two", createdAt: ts("2026-01-01T10:05:00Z") },
    { id: "m3", workspaceId: "ws", conversationId: "v2", from: "them", body: "ig", createdAt: ts("2026-01-02T09:00:00Z"), metaMessageId: "X", reaction: "👍" },
    { id: "m4", workspaceId: "ws", conversationId: "v2", from: "human", body: "ig2", createdAt: ts("2026-01-02T09:30:00Z") },
    { id: "m5", workspaceId: "ws", conversationId: "v3", from: "them", body: "wa again", createdAt: ts("2026-01-03T08:00:00Z") },
  ];
}

describe("CustomerThreadService stitched thread", () => {
  let f: Fake;
  beforeEach(() => {
    f = new Fake();
    seed(f);
  });

  it("orders 3 conversations on 2 channels newest first with a seam after each conversation's first message", async () => {
    const r = await build(f).thread("ws", "c1", viewer, {});
    expect(r.items.map((i: any) => `${i.type}:${i.id}`)).toEqual([
      "message:m5",
      "seam:v3",
      "message:m4",
      "message:m3",
      "seam:v2",
      "message:m2",
      "message:m1",
      "seam:v1",
    ]);
    const seam = r.items.find((i: any) => i.id === "v2") as any;
    expect(seam).toMatchObject({ type: "seam", conversationId: "v2", channel: "instagram", startedAt: "2026-01-02T09:00:00.000Z" });
    const msg = r.items[2] as any;
    expect(msg).toMatchObject({ type: "message", conversationId: "v2", channel: "instagram" });
    expect(msg.message).toMatchObject({ id: "m4", body: "ig2" });
    expect(r.nextBefore).toBeUndefined();
  });

  it("message payloads keep the reaction but never leak metaMessageId", async () => {
    const r = await build(f).thread("ws", "c1", viewer, {});
    const m3 = r.items.find((i: any) => i.id === "m3") as any;
    expect(m3.message.reaction).toBe("👍");
    expect(m3.message).not.toHaveProperty("metaMessageId");
  });

  it("the cursor loads older items with no gaps or duplicates (tiny pages, shared timestamps) and each seam appears once", async () => {
    const same = ts("2026-01-04T00:00:00Z");
    f.messages.push(
      { id: "m6", workspaceId: "ws", conversationId: "v3", from: "them", body: "x", createdAt: same },
      { id: "m7", workspaceId: "ws", conversationId: "v3", from: "them", body: "y", createdAt: same },
    );
    f.ticketActivities = [{ id: "ta1", workspaceId: "ws", ticketId: "t1", kind: "stage_changed", fromStage: "a", toStage: "b", byUserId: "u1", createdAt: same }];
    f.appointments = ["ap1", "ap2", "ap3"].map((id) => ({
      id, workspaceId: "ws", contactId: "c1", service: id, serviceAr: id, status: "cancelled", startAt: same, createdAt: same, updatedAt: same, statusChangedAt: same,
    }));
    const svc = build(f);
    const full = (await svc.thread("ws", "c1", viewer, { limit: 100 })).items.map((i: any) => `${i.type}:${i.id}`);
    for (const limit of [1, 2, 3]) {
      const seen: string[] = [];
      let before: string | undefined;
      for (let i = 0; i < 50; i++) {
        const r = await svc.thread("ws", "c1", viewer, { before, limit });
        seen.push(...r.items.map((x: any) => `${x.type}:${x.id}`));
        if (!r.nextBefore) break;
        before = r.nextBefore;
      }
      expect(seen).toEqual(full);
      expect(seen.filter((x) => x.includes("ap1:"))).toHaveLength(2); // created + status, once each
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.filter((s) => s.startsWith("seam:")).sort()).toEqual(["seam:v1", "seam:v2", "seam:v3"]);
    }
  });

  it("an assigned-only viewer never sees hidden conversations (messages or seams)", async () => {
    f.conversations[1].assigneeId = "u2";
    const r = await build(f, { assigneeId: "u1" }).thread("ws", "c1", viewer, {});
    const ids = r.items.map((i: any) => i.id);
    expect(ids).not.toContain("m3");
    expect(ids).not.toContain("m4");
    expect(ids).not.toContain("v2");
    expect(ids).toEqual(expect.arrayContaining(["m1", "m5", "v1", "v3"]));
  });

  it("an assigned-only viewer with no visible conversation of the contact gets 404 (no event leak)", async () => {
    f.conversations.forEach((c) => (c.assigneeId = "u2"));
    f.ticketActivities = [{ id: "ta1", workspaceId: "ws", ticketId: "t1", kind: "created", createdAt: ts("2026-01-02") }];
    await expect(build(f, { assigneeId: "u1" }).thread("ws", "c1", viewer, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s for a contact outside the workspace", async () => {
    await expect(build(f).thread("ws", "nope", viewer, {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(build(f).thread("other", "c1", viewer, {})).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("CustomerThreadService events", () => {
  let f: Fake;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    f = new Fake();
    seed(f);
  });
  afterEach(() => jest.useRealTimers());

  const events = (r: any) => r.items.filter((i: any) => i.type === "event");

  it("synthesizes ticket events with stage labels", async () => {
    f.ticketActivities = [
      { id: "ta0", workspaceId: "ws", ticketId: "t1", kind: "created", createdAt: ts("2026-01-01T09:00:00Z") },
      { id: "ta1", workspaceId: "ws", ticketId: "t1", kind: "stage_changed", fromStage: "a", toStage: "b", byUserId: "u2", createdAt: ts("2026-01-02T10:00:00Z") },
      { id: "ta2", workspaceId: "ws", ticketId: "t1", kind: "won", fromStage: "b", toStage: "won", byUserId: "u2", createdAt: ts("2026-01-02T11:00:00Z") },
      { id: "ta3", workspaceId: "ws", ticketId: "t1", kind: "lost", note: "Price", createdAt: ts("2026-01-02T12:00:00Z") },
      { id: "ta4", workspaceId: "ws", ticketId: "t1", kind: "note", createdAt: ts("2026-01-02T13:00:00Z") },
    ];
    const r = await build(f).thread("ws", "c1", viewer, {});
    const ev = events(r);
    expect(ev.map((e: any) => [e.kind, e.id])).toEqual([
      ["ticket_lost", "ta3"],
      ["ticket_won", "ta2"],
      ["stage_changed", "ta1"],
      ["ticket_created", "ta0"],
    ]);
    const sc = ev.find((e: any) => e.id === "ta1");
    expect(sc).toMatchObject({ ticketId: "t1", at: "2026-01-02T10:00:00.000Z" });
    expect(sc.data).toMatchObject({
      ticketNumber: 7,
      ticketTitle: "Deal",
      fromStage: "a",
      toStage: "b",
      fromLabel: "Alpha",
      fromLabelAr: "ألفا",
      toLabel: "Beta",
      byUserId: "u2",
    });
  });

  it("flags only the latest stage move, within 10 minutes, still in toStage, by its author as undoable", async () => {
    f.ticketActivities = [
      { id: "old", workspaceId: "ws", ticketId: "t1", kind: "stage_changed", fromStage: "x", toStage: "a", byUserId: "u1", createdAt: ago(5) },
      { id: "latest", workspaceId: "ws", ticketId: "t1", kind: "stage_changed", fromStage: "a", toStage: "b", byUserId: "u1", createdAt: ago(2) },
    ];
    let r = await build(f).thread("ws", "c1", viewer, {});
    const by = (id: string) => events(r).find((e: any) => e.id === id);
    expect(by("latest").undoable).toBe(true);
    expect(by("old").undoable).toBe(false);

    // someone else's move: not undoable for a non-manager, undoable for a manager
    f.ticketActivities[1].byUserId = "u2";
    r = await build(f, {}, ["conversations.view", "tickets.view"]).thread("ws", "c1", viewer, {});
    expect(by("latest").undoable).toBe(false);
    r = await build(f, {}, ["conversations.view", "tickets.view", "tickets.manage"]).thread("ws", "c1", viewer, {});
    expect(by("latest").undoable).toBe(true);

    // expired
    f.ticketActivities[1].byUserId = "u1";
    f.ticketActivities[1].createdAt = ago(11);
    r = await build(f).thread("ws", "c1", viewer, {});
    expect(by("latest").undoable).toBe(false);

    // ticket moved on since
    f.ticketActivities[1].createdAt = ago(2);
    f.tickets[0].stage = { key: "c" };
    r = await build(f).thread("ws", "c1", viewer, {});
    expect(by("latest").undoable).toBe(false);
  });

  it("a stage move out of a Lost stage is not undoable (matches the endpoint)", async () => {
    f.stages.push({ key: "lostk", pipelineId: "p1", workspaceId: "ws", label: "Lost", labelAr: "خسارة", isTerminal: true, isWon: false });
    f.ticketActivities = [
      { id: "reopen", workspaceId: "ws", ticketId: "t1", kind: "stage_changed", fromStage: "lostk", toStage: "b", byUserId: "u1", createdAt: ago(1) },
    ];
    const r = await build(f).thread("ws", "c1", viewer, {});
    expect(events(r).find((e: any) => e.id === "reopen").undoable).toBe(false);
  });

  it("a later close (won/lost) or an undo move makes the earlier stage move not undoable", async () => {
    f.ticketActivities = [
      { id: "mv", workspaceId: "ws", ticketId: "t1", kind: "stage_changed", fromStage: "a", toStage: "b", byUserId: "u1", createdAt: ago(5) },
      { id: "closed", workspaceId: "ws", ticketId: "t1", kind: "won", fromStage: "b", toStage: "b", byUserId: "u1", createdAt: ago(1) },
    ];
    const r = await build(f).thread("ws", "c1", viewer, {});
    expect(events(r).find((e: any) => e.id === "mv").undoable).toBe(false);
  });

  it("booking_status is dated and paged by statusChangedAt: an updatedAt-only change does not move it, null rows are skipped", async () => {
    const statusAt = ts("2026-01-02T11:00:00Z");
    f.appointments = [
      { id: "ap1", workspaceId: "ws", contactId: "c1", service: "Cut", serviceAr: "x", status: "cancelled", startAt: statusAt, createdAt: ts("2026-01-01T00:00:00Z"), updatedAt: ts("2026-03-01T00:00:00Z"), statusChangedAt: statusAt },
      { id: "ap2", workspaceId: "ws", contactId: "c1", service: "Dye", serviceAr: "y", status: "completed", startAt: statusAt, createdAt: ts("2026-01-01T00:00:00Z"), updatedAt: ts("2026-03-02T00:00:00Z"), statusChangedAt: null },
    ];
    const svc = build(f);
    const r = await svc.thread("ws", "c1", viewer, { limit: 100 });
    const st = events(r).filter((e: any) => e.kind === "booking_status");
    expect(st.map((e: any) => [e.id, e.at])).toEqual([["ap1:status", statusAt.toISOString()]]);
    f.appointments[0].updatedAt = ts("2026-06-01T00:00:00Z");
    const r2 = await svc.thread("ws", "c1", viewer, { limit: 100 });
    expect(events(r2).find((e: any) => e.id === "ap1:status").at).toBe(statusAt.toISOString());
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 50; i++) {
      const p = await svc.thread("ws", "c1", viewer, { before, limit: 1 });
      seen.push(...p.items.map((x: any) => `${x.type}:${x.id}`));
      if (!p.nextBefore) break;
      before = p.nextBefore;
    }
    expect(seen.filter((x) => x === "event:ap1:status")).toHaveLength(1);
    expect(seen.some((x) => x.includes("ap2:status"))).toBe(false);
  });

  it("a move whose from-stage no longer exists is not undoable (matches the endpoint)", async () => {
    f.stages = f.stages.filter((s) => s.key !== "a");
    f.ticketActivities = [
      { id: "mv", workspaceId: "ws", ticketId: "t1", kind: "stage_changed", fromStage: "a", toStage: "b", byUserId: "u1", createdAt: ago(1) },
    ];
    const r = await build(f).thread("ws", "c1", viewer, {});
    expect(events(r).find((e: any) => e.id === "mv").undoable).toBe(false);
  });

  it("a user note undo is shown as a note, not treated as an undo marker", async () => {
    f.ticketActivities = [
      { id: "mv", workspaceId: "ws", ticketId: "t1", kind: "stage_changed", fromStage: "a", toStage: "b", byUserId: "u1", note: "undo", createdAt: ago(1) },
    ];
    const r = await build(f).thread("ws", "c1", viewer, {});
    const e = events(r).find((x: any) => x.id === "mv");
    expect(e.data).toMatchObject({ isUndo: false, note: "undo" });
    expect(e.undoable).toBe(true);
  });

  it("booking events need bookings.view; activity_done follows the link permissions", async () => {
    f.appointments = [
      { id: "ap1", workspaceId: "ws", contactId: "c1", service: "Cut", serviceAr: "قص", status: "confirmed", startAt: ts("2026-02-01"), createdAt: ts("2026-01-02T10:00:00Z"), updatedAt: ts("2026-01-02T10:00:00Z") },
      { id: "ap2", workspaceId: "ws", contactId: "c1", service: "Dye", serviceAr: "صبغ", status: "cancelled", startAt: ts("2026-02-02"), createdAt: ts("2026-01-02T08:00:00Z"), updatedAt: ts("2026-01-02T11:00:00Z"), statusChangedAt: ts("2026-01-02T11:00:00Z") },
    ];
    f.activities = [
      { id: "ac1", workspaceId: "ws", contactId: "c1", kind: "call", title: "Called", doneAt: ts("2026-01-02T12:00:00Z"), createdAt: ts("2026-01-01"), ticketId: null, bookingId: null },
      { id: "ac2", workspaceId: "ws", contactId: "c1", kind: "task", title: "Deal task", doneAt: ts("2026-01-02T13:00:00Z"), createdAt: ts("2026-01-01"), ticketId: "t1", bookingId: null },
    ];
    const all = await build(f).thread("ws", "c1", viewer, {});
    const ev = events(all).map((e: any) => [e.kind, e.id, e.appointmentId ?? e.ticketId ?? null]);
    expect(ev).toEqual(
      expect.arrayContaining([
        ["booking_created", "ap1:created", "ap1"],
        ["booking_created", "ap2:created", "ap2"],
        ["booking_status", "ap2:status", "ap2"],
        ["activity_done", "ac1", null],
        ["activity_done", "ac2", "t1"],
      ]),
    );

    const noBookings = await build(f, {}, ["conversations.view", "tickets.view"]).thread("ws", "c1", viewer, {});
    expect(events(noBookings).some((e: any) => e.kind.startsWith("booking_"))).toBe(false);
    f.appointment.findMany.mockClear();
    f.ticketActivity.findMany.mockClear();
    const none = await build(f, {}, ["conversations.view"]).thread("ws", "c1", viewer, {});
    expect(f.appointment.findMany).not.toHaveBeenCalled();
    expect(f.ticketActivity.findMany).not.toHaveBeenCalled();
    expect(events(none).map((e: any) => e.id)).toEqual(["ac1"]); // ticket-linked task hidden without tickets.view
  });
});
