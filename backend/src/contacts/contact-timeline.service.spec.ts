import { NotFoundException } from "@nestjs/common";
import { ContactTimelineService } from "./contact-timeline.service";

type Row = Record<string, any>;
const ts = (s: string) => new Date(s);

function cmp(v: any, c: any): boolean {
  if (c === null) return v == null;
  if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
  if (typeof c === "object" && !Array.isArray(c)) {
    return Object.entries<any>(c).every(([op, x]) => {
      const t = (y: any) => (y instanceof Date ? y.getTime() : y);
      if (op === "in") return x.includes(v);
      if (op === "lt") return v != null && t(v) < t(x);
      if (op === "lte") return v != null && t(v) <= t(x);
      return true;
    });
  }
  return v === c;
}

class Fake {
  contacts: Row[] = [{ id: "c1", workspaceId: "ws" }];
  activities: Row[] = [];
  notes: Row[] = [];
  ticketActivities: Row[] = [];
  messages: Row[] = [];
  conversations: Row[] = [];
  tickets: Row[] = [{ id: "t1", contactId: "c1", workspaceId: "ws" }];
  members: Row[] = [];

  private match(row: Row, where: Row, rel: (k: string, r: Row, w: Row) => boolean): boolean {
    return Object.entries<any>(where).every(([k, c]) => {
      if (k === "OR") return c.some((w: Row) => this.match(row, w, rel));
      if (k === "AND") return c.every((w: Row) => this.match(row, w, rel));
      if (k === "conversation" || k === "ticket") return rel(k, row, c);
      return cmp(row[k], c);
    });
  }
  private find(rows: Row[], args: Row, rel: (k: string, r: Row, w: Row) => boolean = () => true) {
    let out = rows.filter((r) => this.match(r, args.where ?? {}, rel));
    out = out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    return out.slice(0, args.take ?? out.length);
  }
  private convRel = (k: string, r: Row, w: Row) => {
    const conv = this.conversations.find((c) => c.id === r.conversationId);
    return !!conv && this.match(conv, w, () => true);
  };
  private ticketRel = (_k: string, r: Row, w: Row) => {
    const t = this.tickets.find((x) => x.id === r.ticketId);
    return !!t && this.match(t, w, () => true);
  };
  contact = { findFirst: jest.fn(async ({ where }: any) => this.contacts.find((c) => this.match(c, where, () => true)) ?? null) };
  workspaceMember = { findFirst: jest.fn(async ({ where }: any) => this.members.find((m) => this.match(m, where, () => true)) ?? null) };
  activity = { findMany: jest.fn(async (a: any) => this.find(this.activities, a)) };
  note = { findMany: jest.fn(async (a: any) => this.find(this.notes, a)) };
  ticketActivity = { findMany: jest.fn(async (a: any) => this.find(this.ticketActivities, a, this.ticketRel)) };
  message = {
    findMany: jest.fn(async (a: any) =>
      this.find(this.messages, a, this.convRel).map((m) => ({
        ...m,
        conversation: this.conversations.find((c) => c.id === m.conversationId),
      })),
    ),
  };
  conversation = {
    findMany: jest.fn(async ({ where }: any) => this.conversations.filter((c) => this.match(c, where, () => true))),
  };
}

function build(f: Fake, scope: Row = {}, granted?: string[]) {
  const perm = {
    viewerCan: jest.fn(async (_w: string, _v: unknown, p: string) => !granted || granted.includes(p)),
    conversationScope: jest.fn(async () => scope),
    effective: jest.fn(async () => ({ permissions: ["contacts.view"], conversationVisibility: "all" })),
    can: jest.fn(() => true),
  };
  return new ContactTimelineService(f as never, perm as never);
}

describe("ContactTimelineService", () => {
  let f: Fake;
  beforeEach(() => {
    f = new Fake();
    f.members = [{ userId: "u1", workspaceId: "ws" }];
    f.conversations = [{ id: "v1", contactId: "c1", workspaceId: "ws", channel: "whatsapp", assigneeId: "u1" }];
    f.activities = [{ id: "a1", workspaceId: "ws", contactId: "c1", kind: "call", title: "Call", createdAt: ts("2026-01-04") }];
    f.notes = [{ id: "n1", workspaceId: "ws", contactId: "c1", parentId: null, conversationId: null, body: "hi", createdAt: ts("2026-01-03") }];
    f.ticketActivities = [{ id: "ta1", workspaceId: "ws", ticketId: "t1", kind: "stage_changed", createdAt: ts("2026-01-02") }];
    f.messages = [{ id: "m1", workspaceId: "ws", conversationId: "v1", from: "them", body: "yo", createdAt: ts("2026-01-01") }];
  });
  const viewer = { userId: "u1" };

  it("merges the four sources newest first with typed items", async () => {
    const r = await build(f).timeline("ws", "c1", viewer, {});
    expect(r.items.map((i) => [i.type, i.id])).toEqual([
      ["activity", "a1"],
      ["note", "n1"],
      ["ticket_activity", "ta1"],
      ["message", "m1"],
    ]);
    expect(r.items[0].at).toBe("2026-01-04T00:00:00.000Z");
    expect(r.nextBefore).toBeUndefined();
    const msg = r.items[3].data as any;
    expect(msg.conversationId).toBe("v1");
    expect(msg.channel).toBe("whatsapp");
  });

  it("pages without gaps or duplicates when items share a timestamp", async () => {
    const same = ts("2026-02-01");
    f.activities = ["a1", "a2", "a3"].map((id) => ({ id, workspaceId: "ws", contactId: "c1", kind: "call", title: id, createdAt: same }));
    f.notes = ["n1", "n2", "n3"].map((id) => ({ id, workspaceId: "ws", contactId: "c1", parentId: null, conversationId: null, body: id, createdAt: same }));
    f.messages = ["m1", "m2"].map((id) => ({ id, workspaceId: "ws", conversationId: "v1", from: "them", body: id, createdAt: same }));
    f.ticketActivities = [{ id: "ta1", workspaceId: "ws", ticketId: "t1", kind: "created", createdAt: same }];
    const svc = build(f);
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await svc.timeline("ws", "c1", viewer, { before, limit: 2 });
      seen.push(...r.items.map((x) => `${x.type}:${x.id}`));
      if (!r.nextBefore) break;
      before = r.nextBefore;
    }
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });

  it("an assigned-only viewer does not see messages or notes of hidden conversations", async () => {
    f.conversations.push({ id: "v2", contactId: "c1", workspaceId: "ws", channel: "instagram", assigneeId: "u2" });
    f.messages.push({ id: "m2", workspaceId: "ws", conversationId: "v2", from: "them", body: "secret", createdAt: ts("2026-01-05") });
    f.notes.push({ id: "n2", workspaceId: "ws", contactId: "c1", parentId: null, conversationId: "v2", body: "hidden", createdAt: ts("2026-01-06") });
    const r = await build(f, { assigneeId: "u1" }).timeline("ws", "c1", viewer, {});
    const ids = r.items.map((i) => i.id);
    expect(ids).not.toContain("m2");
    expect(ids).not.toContain("n2");
    expect(ids).toContain("m1");
    expect(ids).toContain("n1");
  });

  it("only includes ticket activities of this contact's tickets", async () => {
    f.tickets.push({ id: "t2", contactId: "other", workspaceId: "ws" });
    f.ticketActivities.push({ id: "ta2", workspaceId: "ws", ticketId: "t2", kind: "created", createdAt: ts("2026-01-09") });
    const r = await build(f).timeline("ws", "c1", viewer, {});
    expect(r.items.map((i) => i.id)).not.toContain("ta2");
  });

  it("a contacts.view-only viewer gets no ticket, ticket-linked, message or conversation-note data", async () => {
    f.activities.push({ id: "a2", workspaceId: "ws", contactId: "c1", ticketId: "t1", kind: "task", title: "T", createdAt: ts("2026-01-07") });
    f.notes.push({ id: "n2", workspaceId: "ws", contactId: "c1", parentId: null, conversationId: "v1", body: "conv", createdAt: ts("2026-01-08") });
    const r = await build(f, {}, ["contacts.view"]).timeline("ws", "c1", viewer, {});
    expect(r.items.map((i) => i.id).sort()).toEqual(["a1", "n1"]);
    expect(f.ticketActivity.findMany).not.toHaveBeenCalled();
    expect(f.message.findMany).not.toHaveBeenCalled();
  });

  it("a viewer with everything is unchanged and message payloads omit metaMessageId", async () => {
    f.messages[0].metaMessageId = "wamid.X";
    const r = await build(f, {}, ["contacts.view", "tickets.view", "conversations.view"]).timeline("ws", "c1", viewer, {});
    expect(r.items.map((i) => i.id)).toEqual(["a1", "n1", "ta1", "m1"]);
    expect(r.items[3].data).not.toHaveProperty("metaMessageId");
  });

  it("404s for a contact outside the workspace", async () => {
    await expect(build(f).timeline("ws", "nope", viewer, {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(build(f).timeline("other-ws", "c1", viewer, {})).rejects.toBeInstanceOf(NotFoundException);
  });
});
