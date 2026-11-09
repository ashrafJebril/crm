import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ActivitiesService } from "./activities.service";
import { FakePrisma } from "./activities-test-fakes";

const NOW = new Date("2026-11-10T08:00:00Z"); // 12:00 Asia/Dubai
const ALL = ["contacts.view", "contacts.update", "contacts.delete", "tickets.view", "tickets.update", "tickets.delete"];

function setup(perms: Record<string, { perms: string[]; vis?: string }> = {}) {
  const prisma = new FakePrisma();
  const notifications = { notify: jest.fn().mockResolvedValue(1) };
  const effs: Record<string, any> = {};
  if (!("u2" in perms)) perms = { ...perms, u2: { perms: ALL } };
  for (const [u, p] of Object.entries(perms)) effs[u] = { permissions: p.perms, conversationVisibility: p.vis ?? "all" };
  const perm = {
    effective: jest.fn(async (_w: string, u: string) => effs[u] ?? null),
    can: jest.fn((eff: any, p: string) => !!eff && eff.permissions.includes(p)),
  };
  const svc = new ActivitiesService(prisma as never, notifications as never, perm as never);
  svc.now = () => NOW;
  return { prisma, notifications, perm, svc };
}
const me = { userId: "u1" };

describe("ActivitiesService CRUD", () => {
  it("creates a follow_up on a contact, defaulting the assignee to the actor", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL } });
    const a = await svc.create("ws", { kind: "follow_up", title: "Ring", dueAt: "2026-11-11T08:00:00Z", contactId: "c1" }, "u1", me);
    expect(a).toMatchObject({ kind: "follow_up", contactId: "c1", assigneeId: "u1", doneAt: null, createdById: "u1" });
    expect(prisma.activity.create.mock.calls[0][0].data.workspaceId).toBe("ws");
  });

  it("linking to a ticket sets the ticket's contactId", async () => {
    const { svc } = setup({ u1: { perms: ALL } });
    const a = await svc.create("ws", { kind: "task", title: "Send quote", dueAt: "2026-11-11T08:00:00Z", ticketId: "t1" }, "u1", me);
    expect(a).toMatchObject({ ticketId: "t1", contactId: "c1" });
    expect(a.ticket).toMatchObject({ number: 7 });
  });

  it("a ticket link with a different contactId is rejected", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL } });
    prisma.contacts.push({ id: "c2", name: "Other", workspaceId: "ws" });
    await expect(
      svc.create("ws", { kind: "task", title: "x", dueAt: "2026-11-11T08:00:00Z", ticketId: "t1", contactId: "c2" }, "u1", me),
    ).rejects.toThrow(BadRequestException);
  });

  it("follow_up and task require dueAt; a link is required", async () => {
    const { svc } = setup({ u1: { perms: ALL } });
    await expect(svc.create("ws", { kind: "follow_up", title: "x", contactId: "c1" }, "u1", me)).rejects.toThrow(BadRequestException);
    await expect(svc.create("ws", { kind: "task", title: "x", dueAt: "2026-11-11T08:00:00Z" }, "u1", me)).rejects.toThrow(BadRequestException);
  });

  it("logged kinds are done on creation unless dueAt is in the future", async () => {
    const { svc } = setup({ u1: { perms: ALL } });
    const call = await svc.create("ws", { kind: "call", title: "Spoke", contactId: "c1" }, "u1", me);
    expect(call.doneAt).toEqual(NOW);
    const meeting = await svc.create("ws", { kind: "meeting", title: "Demo", contactId: "c1", dueAt: "2026-11-12T08:00:00Z" }, "u1", me);
    expect(meeting.doneAt).toBeNull();
    const past = await svc.create("ws", { kind: "meeting", title: "Demo", contactId: "c1", dueAt: "2026-11-09T08:00:00Z" }, "u1", me);
    expect(past.doneAt).toEqual(NOW);
  });

  it.each([
    ["contact", { contactId: "nope" }],
    ["ticket", { ticketId: "nope" }],
    ["booking", { contactId: "c1", bookingId: "nope" }],
    ["assignee", { contactId: "c1", assigneeId: "ghost" }],
  ])("foreign %s id -> 404", async (_n, link) => {
    const { svc } = setup({ u1: { perms: ALL } });
    await expect(svc.create("ws", { kind: "call", title: "x", ...link } as never, "u1", me)).rejects.toThrow(NotFoundException);
  });

  it("contact activities need contacts.update, ticket activities tickets.update", async () => {
    const { svc } = setup({ u1: { perms: ["contacts.update"] } });
    await expect(svc.create("ws", { kind: "call", title: "x", contactId: "c1" }, "u1", me)).resolves.toBeDefined();
    await expect(svc.create("ws", { kind: "call", title: "x", ticketId: "t1" }, "u1", me)).rejects.toThrow(ForbiddenException);
  });

  it("notifies a new assignee other than the actor with assignment.activity", async () => {
    const { svc, notifications } = setup({ u1: { perms: ALL } });
    await svc.create("ws", { kind: "follow_up", title: "Ring", dueAt: "2026-11-11T08:00:00Z", contactId: "c1", assigneeId: "u2" }, "u1", me);
    expect(notifications.notify).toHaveBeenCalledWith(
      "ws",
      ["u2"],
      expect.objectContaining({ type: "assignment", title: "assignment.activity", recordKind: "contact", recordId: "c1", actorId: "u1" }),
    );
    notifications.notify.mockClear();
    await svc.create("ws", { kind: "follow_up", title: "Ring", dueAt: "2026-11-11T08:00:00Z", contactId: "c1" }, "u1", me);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("assigning to a member who cannot open the record -> 400 activities.assignee_no_access", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL }, u2: { perms: [] } });
    await expect(
      svc.create("ws", { kind: "follow_up", title: "x", dueAt: "2026-11-11T08:00:00Z", contactId: "c1", assigneeId: "u2" }, "u1", me),
    ).rejects.toThrow("activities.assignee_no_access");
    const row = prisma.seed();
    await expect(svc.update("ws", row.id, { assigneeId: "u2" }, "u1", me)).rejects.toThrow("activities.assignee_no_access");
  });

  it("bulk reassign skips records the new assignee cannot open", async () => {
    const { svc, prisma, notifications } = setup({ u1: { perms: ALL }, u2: { perms: ["contacts.view"] } });
    prisma.seed({ id: "a" });
    prisma.seed({ id: "b", ticketId: "t1" });
    expect(await svc.bulk("ws", { ids: ["a", "b"], op: "reassign", assigneeId: "u2" }, "u1", me)).toEqual({ affected: 1, skipped: 1 });
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });

  it("update: reschedule and reassign clear notifiedAt; assignee change notifies", async () => {
    const { svc, prisma, notifications } = setup({ u1: { perms: ALL } });
    const row = prisma.seed({ notifiedAt: new Date("2026-11-10T08:00:00Z") });
    await svc.update("ws", row.id, { dueAt: "2026-11-12T08:00:00Z" }, "u1", me);
    expect(prisma.activities[0].notifiedAt).toBeNull();
    prisma.activities[0].notifiedAt = NOW;
    await svc.update("ws", row.id, { assigneeId: "u2" }, "u1", me);
    expect(prisma.activities[0].notifiedAt).toBeNull();
    expect(notifications.notify).toHaveBeenCalledWith("ws", ["u2"], expect.objectContaining({ title: "assignment.activity" }));
  });

  it("update cannot clear dueAt on a follow_up; unknown id -> 404", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL } });
    const row = prisma.seed();
    await expect(svc.update("ws", row.id, { dueAt: null }, "u1", me)).rejects.toThrow(BadRequestException);
    await expect(svc.update("ws", "zz", { title: "x" }, "u1", me)).rejects.toThrow(NotFoundException);
  });

  it("update: a same-minute dueAt does not re-arm the notification; a new minute does", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL } });
    const row = prisma.seed({ notifiedAt: NOW, dueAt: new Date("2026-11-10T08:00:00Z") });
    await svc.update("ws", row.id, { dueAt: "2026-11-10T08:00:40Z" }, "u1", me);
    expect(prisma.activities[0].notifiedAt).toEqual(NOW);
    await svc.update("ws", row.id, { dueAt: "2026-11-10T08:01:00Z" }, "u1", me);
    expect(prisma.activities[0].notifiedAt).toBeNull();
  });

  it("update: clearing dueAt on an open follow_up/task/meeting is activities.due_required; a logged call may", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL } });
    for (const kind of ["follow_up", "task", "meeting"]) {
      const row = prisma.seed({ kind });
      await expect(svc.update("ws", row.id, { dueAt: null }, "u1", me)).rejects.toThrow("activities.due_required");
    }
    const call = prisma.seed({ kind: "call", doneAt: NOW });
    await svc.update("ws", call.id, { dueAt: null }, "u1", me);
    expect(prisma.activities.find((x) => x.id === call.id)!.dueAt).toBeNull();
  });

  it("create: the permission check runs before the ticket/contact existence checks", async () => {
    const { svc } = setup({ u1: { perms: ["contacts.update"] } });
    await expect(
      svc.create("ws", { kind: "task", title: "x", dueAt: "2026-11-11T08:00:00Z", ticketId: "missing" }, "u1", me),
    ).rejects.toThrow(ForbiddenException);
  });

  it("bulk reassign looks up the assignee's permissions once", async () => {
    const { svc, prisma, perm } = setup({ u1: { perms: ALL }, u2: { perms: ["contacts.view"] } });
    for (let i = 0; i < 5; i++) prisma.seed({ id: `r${i}` });
    perm.effective.mockClear();
    await svc.bulk("ws", { ids: ["r0", "r1", "r2", "r3", "r4"], op: "reassign", assigneeId: "u2" }, "u1", me);
    expect(perm.effective.mock.calls.filter((c: any[]) => c[1] === "u2")).toHaveLength(1);
  });

  it("an activity in another workspace is a 404", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL } });
    const row = prisma.seed({ workspaceId: "other" });
    await expect(svc.complete("ws", row.id, {}, me)).rejects.toThrow(NotFoundException);
  });

  it("complete sets doneAt and outcome, and is idempotent", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL } });
    const row = prisma.seed();
    const done = await svc.complete("ws", row.id, { outcome: "Booked demo" }, me);
    expect(done).toMatchObject({ doneAt: NOW, outcome: "Booked demo" });
    prisma.activity.update.mockClear();
    await svc.complete("ws", row.id, { outcome: "again" }, me);
    expect(prisma.activity.update).not.toHaveBeenCalled();
  });

  it("delete needs .delete by link", async () => {
    const { svc, prisma } = setup({ u1: { perms: ["contacts.update", "contacts.view"] } });
    const row = prisma.seed();
    await expect(svc.remove("ws", row.id, me)).rejects.toThrow(ForbiddenException);
    const s2 = setup({ u1: { perms: ["contacts.delete"] } });
    const r2 = s2.prisma.seed();
    await expect(s2.svc.remove("ws", r2.id, me)).resolves.toEqual({ ok: true });
    expect(s2.prisma.activities).toHaveLength(0);
  });

  it("list by contact needs contacts.view and verifies the contact; newest first with a cursor", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL } });
    await svc.list("ws", { contactId: "c1", limit: 2 }, me);
    const args = prisma.activity.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(args.take).toBe(3);
    await expect(svc.list("ws", { contactId: "zz" }, me)).rejects.toThrow(NotFoundException);
    await expect(svc.list("ws", {}, me)).rejects.toThrow(BadRequestException);
    const s2 = setup({ u1: { perms: [] } });
    await expect(s2.svc.list("ws", { contactId: "c1" }, me)).rejects.toThrow(ForbiddenException);
  });

  it("list by contact hides ticket-linked rows from a viewer without tickets.view", async () => {
    const { svc, prisma } = setup({ u1: { perms: ["contacts.view"] } });
    await svc.list("ws", { contactId: "c1" }, me);
    expect(prisma.activity.findMany.mock.calls[0][0].where).toMatchObject({ contactId: "c1", ticketId: null });
  });
});

describe("queue", () => {
  const seedAll = (prisma: FakePrisma) => {
    prisma.seed({ id: "od", dueAt: new Date("2026-11-10T07:59:00Z") }); // 1 min ago
    prisma.seed({ id: "td", dueAt: new Date("2026-11-10T19:30:00Z") }); // 23:30 local
    prisma.seed({ id: "up", dueAt: new Date("2026-11-10T20:30:00Z") }); // 00:30 tomorrow
    prisma.seed({ id: "done", dueAt: new Date("2026-11-10T07:00:00Z"), doneAt: NOW });
    prisma.seed({ id: "other", assigneeId: "u2", dueAt: new Date("2026-11-10T19:00:00Z") });
  };

  it("mine: buckets in the workspace timezone, done excluded, counts", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL } });
    seedAll(prisma);
    const q = await svc.queue("ws", { scope: "mine" }, me);
    expect(q.overdue.map((a: any) => a.id)).toEqual(["od"]);
    expect(q.today.map((a: any) => a.id)).toEqual(["td"]);
    expect(q.upcoming.map((a: any) => a.id)).toEqual(["up"]);
    expect(q.counts).toEqual({ overdue: 1, today: 1, upcoming: 1 });
    expect(q.upcoming[0].contact).toEqual({ id: "c1", name: "Ali" });
  });

  it("team: includes other assignees, filterable by assignee, kind and pipeline", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL } });
    seedAll(prisma);
    const q = await svc.queue("ws", { scope: "team" }, me);
    expect(q.counts.today).toBe(2);
    const q2 = await svc.queue("ws", { scope: "team", assigneeId: "u2", kind: "task", pipelineId: "p1" }, me);
    const where = prisma.activity.findMany.mock.calls.at(-1)![0].where;
    expect(JSON.stringify(where)).toContain('"assigneeId":"u2"');
    expect(JSON.stringify(where)).toContain('"kind":"task"');
    expect(JSON.stringify(where)).toContain('"pipelineId":"p1"');
    expect(q2.counts).toBeDefined();
  });

  it("upcoming is paged by 50 with a cursor", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL } });
    for (let i = 0; i < 60; i++) prisma.seed({ id: `u${i}`, dueAt: new Date(Date.UTC(2026, 10, 12, 0, i)) });
    const q = await svc.queue("ws", { scope: "mine", cursorUpcoming: "u9" }, me);
    const args = prisma.activity.findMany.mock.calls.map((c) => c[0]).find((a) => a.cursor)!;
    expect(args).toMatchObject({ cursor: { id: "u9" }, skip: 1, take: 51 });
    expect(q).toHaveProperty("nextCursorUpcoming");
  });

  it("assigned-only viewer with contacts.view sees teammates' activities on shared contacts", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL, vis: "assigned" } });
    seedAll(prisma);
    const q = await svc.queue("ws", { scope: "team" }, me);
    expect(q.counts.today).toBe(2); // includes u2's activity
    const where = JSON.stringify(prisma.activity.findMany.mock.calls[0][0].where);
    expect(where).not.toContain("conversations");
    expect(where).not.toContain("ownerId");
  });

  it("a viewer without tickets.view never sees ticket-linked rows; with neither view, nothing", async () => {
    const { svc, prisma } = setup({ u1: { perms: ["contacts.view"] }, u2: { perms: [] } });
    seedAll(prisma);
    await svc.queue("ws", { scope: "mine" }, me);
    expect(JSON.stringify(prisma.activity.findMany.mock.calls[0][0].where)).toContain('"ticketId":null');
    const q = await svc.queue("ws", { scope: "mine" }, { userId: "u2" });
    expect(q).toMatchObject({ overdue: [], today: [], upcoming: [], counts: { overdue: 0, today: 0, upcoming: 0 } });
  });
});

describe("bulk", () => {
  it("reschedule with mixed permissions applies the permitted ones and reports skipped", async () => {
    const { svc, prisma } = setup({ u1: { perms: ["contacts.update"] } });
    const a = prisma.seed({ id: "a" });
    const b = prisma.seed({ id: "b", ticketId: "t1" }); // needs tickets.update
    const r = await svc.bulk("ws", { ids: [a.id, b.id, "ghost"], op: "reschedule", dueAt: "2026-11-15T08:00:00Z" }, "u1", me);
    expect(r).toEqual({ affected: 1, skipped: 2 });
    expect(prisma.activities.find((x) => x.id === "a")!.dueAt).toEqual(new Date("2026-11-15T08:00:00Z"));
    expect(prisma.activities.find((x) => x.id === "b")!.dueAt).toEqual(new Date("2026-11-10T08:00:00Z"));
    expect(prisma.activities.find((x) => x.id === "a")!.notifiedAt).toBeNull();
  });

  it("done and reassign", async () => {
    const { svc, prisma, notifications } = setup({ u1: { perms: ALL } });
    prisma.seed({ id: "a" });
    prisma.seed({ id: "b" });
    expect(await svc.bulk("ws", { ids: ["a"], op: "done" }, "u1", me)).toEqual({ affected: 1, skipped: 0 });
    expect(prisma.activities[0].doneAt).toEqual(NOW);
    // already done -> skipped
    expect(await svc.bulk("ws", { ids: ["a", "b"], op: "reassign", assigneeId: "u2" }, "u1", me)).toEqual({ affected: 1, skipped: 1 });
    expect(prisma.activities[1].assigneeId).toBe("u2");
    expect(notifications.notify).toHaveBeenCalledWith("ws", ["u2"], expect.objectContaining({ title: "assignment.activity" }));
  });

  it("validates: over 500 ids, missing dueAt/assigneeId, foreign assignee", async () => {
    const { svc } = setup({ u1: { perms: ALL } });
    await expect(svc.bulk("ws", { ids: Array.from({ length: 501 }, (_, i) => `i${i}`), op: "done" }, "u1", me)).rejects.toThrow(BadRequestException);
    await expect(svc.bulk("ws", { ids: ["a"], op: "reschedule" }, "u1", me)).rejects.toThrow(BadRequestException);
    await expect(svc.bulk("ws", { ids: ["a"], op: "reassign" }, "u1", me)).rejects.toThrow(BadRequestException);
    await expect(svc.bulk("ws", { ids: ["a"], op: "reassign", assigneeId: "ghost" }, "u1", me)).rejects.toThrow(NotFoundException);
  });
});

describe("next-steps", () => {
  it("costs one findMany with `in` and returns the earliest open activity per contact", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL } });
    prisma.seed({ id: "late", title: "Later", dueAt: new Date("2026-11-20T08:00:00Z") });
    prisma.seed({ id: "early", title: "Sooner", dueAt: new Date("2026-11-09T08:00:00Z") });
    prisma.seed({ id: "x", doneAt: NOW });
    const r = await svc.nextSteps("ws", { contactIds: ["c1", "c2"] }, me);
    expect(prisma.activity.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.activity.findMany.mock.calls[0][0].where.contactId).toEqual({ in: ["c1", "c2"] });
    expect(prisma.activity.count).not.toHaveBeenCalled();
    expect(r).toEqual({
      c1: {
        activityId: "early",
        kind: "follow_up",
        title: "Sooner",
        dueAt: new Date("2026-11-09T08:00:00Z"),
        overdue: true,
        ticketId: null,
        assigneeId: "u1",
        notes: null,
        outcome: null,
      },
    });
  });

  it("ticketIds use ticketId; neither list -> 400; without view permission -> 403", async () => {
    const { svc, prisma } = setup({ u1: { perms: ALL }, u2: { perms: [] } });
    await svc.nextSteps("ws", { ticketIds: ["t1"] }, me);
    expect(prisma.activity.findMany.mock.calls[0][0].where.ticketId).toEqual({ in: ["t1"] });
    await expect(svc.nextSteps("ws", {}, me)).rejects.toThrow(BadRequestException);
    await expect(svc.nextSteps("ws", { contactIds: ["c1"] }, { userId: "u2" })).rejects.toThrow(ForbiddenException);
  });
});
