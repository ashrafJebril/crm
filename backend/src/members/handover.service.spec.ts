import { BadRequestException, ForbiddenException, HttpException } from "@nestjs/common";
import { makeWorld, NOW, U, withRollback, WS } from "./__fixtures__/members-world";

const owner = { userId: U.owner };
const T0 = new Date("2026-11-10T08:00:00.000Z");

/** One of every open kind for `userId`, plus closed work that must stay. */
function seedWork(w: ReturnType<typeof makeWorld>, userId: string, opts: { closed?: boolean } = {}) {
  const conv = (id: string, status: string) => ({
    id, workspaceId: WS, assigneeId: userId, status, contactId: "ct1", channel: "whatsapp", version: 3, updatedAt: T0, createdAt: T0,
  });
  const ticket = (id: string, pipelineId: string, closedAt: Date | null) => ({
    id, workspaceId: WS, ownerId: userId, pipelineId, stageId: "s1", contactId: "ct1", title: id, closedAt, createdAt: T0, updatedAt: T0,
  });
  w.db.conversation.push(conv("c_open", "human"));
  w.db.ticket.push(ticket("t_deal", "p_deals", null), ticket("t_lead", "p_leads", null));
  w.db.activity.push({ id: "a_open", workspaceId: WS, assigneeId: userId, kind: "call", doneAt: null, createdAt: T0, updatedAt: T0 });
  w.db.contact.push({ id: "ct_owned", workspaceId: WS, ownerId: userId, name: "Owned", createdAt: T0, updatedAt: T0 });
  // A booking is shown, never moved.
  w.db.appointment.push({ id: "b1", workspaceId: WS, staffId: userId, startAt: new Date(NOW.getTime() + 86_400_000), status: "confirmed" });
  if (opts.closed) {
    w.db.conversation.push(conv("c_resolved", "resolved"), conv("c_closed", "closed"), conv("c_spam", "spam"));
    w.db.ticket.push(ticket("t_won", "p_deals", T0));
    w.db.activity.push({ id: "a_done", workspaceId: WS, assigneeId: userId, kind: "call", doneAt: T0, createdAt: T0, updatedAt: T0 });
    w.db.appointment.push({ id: "b_past", workspaceId: WS, staffId: userId, startAt: T0, status: "completed" });
  }
}

const OPEN = { conversations: 1, tickets: { deals: 1, leads: 1, support: 0 }, followUps: 1, contacts: 1, bookings: 1, total: 5 };

async function failure(p: Promise<unknown>) {
  const e = await p.then(
    () => {
      throw new Error("expected a failure");
    },
    (err: unknown) => err,
  );
  if (!(e instanceof HttpException)) throw e;
  return { status: e.getStatus(), body: e.getResponse() as Record<string, unknown> };
}

const isMember = (w: ReturnType<typeof makeWorld>, userId: string) =>
  w.db.workspaceMember.some((m) => m.userId === userId && m.workspaceId === WS);

describe("HandoverService (SP-26)", () => {
  it("delete-member-with-references requires handoverTo when open work > 0", async () => {
    const w = makeWorld();
    withRollback(w.prisma);
    seedWork(w, U.agent);

    // Without handoverTo: 409 with exact counts; the membership stays.
    const refused = await failure(w.handover.removeWithHandover(WS, U.agent, owner));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ message: "members.handover_required", openWork: OPEN });
    expect(isMember(w, U.agent)).toBe(true);

    // With handoverTo: every row moved, membership deleted, one audit row, one notification.
    const res = await w.handover.removeWithHandover(WS, U.agent, owner, U.admin);
    expect(res).toEqual({ ok: true, moved: { ...OPEN, bookings: 0 } });
    expect(isMember(w, U.agent)).toBe(false);
    expect(w.db.conversation.find((c) => c.id === "c_open").assigneeId).toBe(U.admin);
    expect(w.db.ticket.filter((t) => t.ownerId === U.admin).map((t) => t.id).sort()).toEqual(["t_deal", "t_lead"]);
    expect(w.db.activity.find((a) => a.id === "a_open").assigneeId).toBe(U.admin);
    expect(w.db.contact.find((c) => c.id === "ct_owned").ownerId).toBe(U.admin);
    expect(w.db.appointment.find((b) => b.id === "b1").staffId).toBe(U.agent);
    const audits = w.db.auditLog.filter((a) => a.action === "member.removed");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ workspaceId: WS, actorId: U.owner, targetKind: "member", targetId: U.agent });
    expect(audits[0].meta).toEqual({ handoverTo: U.admin, moved: { ...OPEN, bookings: 0 } });
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
    expect(w.notifications.notify).toHaveBeenCalledWith(WS, [U.admin], expect.objectContaining({ type: "assignment", actorId: U.owner }));
    expect(w.realtime.emitToWorkspace).toHaveBeenCalledWith(WS, "inbox.activity", { reason: "handover" });

    // A member with no open work is removed without handoverTo.
    const plain = await w.handover.removeWithHandover(WS, U.viewer, owner);
    expect(plain.moved.total).toBe(0);
    expect(isMember(w, U.viewer)).toBe(false);
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
  });

  it("handover moves every open kind and leaves closed work", async () => {
    const w = makeWorld();
    seedWork(w, U.agent, { closed: true });
    const res = await w.handover.handOverOnly(WS, U.agent, U.admin, owner);
    expect(res.moved).toEqual({ ...OPEN, bookings: 0 });
    // The member stays.
    expect(isMember(w, U.agent)).toBe(true);
    const conv = (id: string) => w.db.conversation.find((c) => c.id === id);
    expect(conv("c_open")).toMatchObject({ assigneeId: U.admin, version: 4 });
    expect(conv("c_open").updatedAt).toEqual(T0); // inbox order kept
    for (const id of ["c_resolved", "c_closed", "c_spam"]) expect(conv(id)).toMatchObject({ assigneeId: U.agent, version: 3 });
    expect(w.db.ticket.find((t) => t.id === "t_won").ownerId).toBe(U.agent);
    expect(w.db.activity.find((a) => a.id === "a_done").assigneeId).toBe(U.agent);
    expect(w.db.auditLog.filter((a) => a.action === "member.handover")).toHaveLength(1);
    // Nothing left open with the old member.
    expect(await w.handover.openWork(w.prisma, WS, U.agent)).toEqual({
      conversations: 0, tickets: { deals: 0, leads: 0, support: 0 }, followUps: 0, contacts: 0, bookings: 1, total: 0,
    });
  });

  it("handover to a member without tickets.update is refused", async () => {
    const w = makeWorld();
    withRollback(w.prisma);
    seedWork(w, U.agent);
    const before = JSON.stringify([w.db.conversation, w.db.ticket, w.db.activity, w.db.contact]);
    for (const run of [
      () => w.handover.removeWithHandover(WS, U.agent, owner, U.limited),
      () => w.handover.handOverOnly(WS, U.agent, U.limited, owner),
    ]) {
      const refused = await failure(run());
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ message: "members.handover_refused", reason: "missing_permission", resource: "tickets" });
    }
    expect(JSON.stringify([w.db.conversation, w.db.ticket, w.db.activity, w.db.contact])).toBe(before);
    expect(isMember(w, U.agent)).toBe(true);
    expect(w.db.auditLog).toHaveLength(0);
    expect(w.notifications.notify).not.toHaveBeenCalled();
    // The preview names the same refusal; a non-member or the member itself is refused too.
    expect(await w.handover.openWorkFor(WS, U.agent, U.limited)).toMatchObject({ total: 5, refusal: { reason: "missing_permission", resource: "tickets" } });
    expect((await w.handover.openWorkFor(WS, U.agent, U.other)).refusal).toEqual({ reason: "not_member" });
    expect((await w.handover.openWorkFor(WS, U.agent, U.agent)).refusal).toEqual({ reason: "same_user" });
  });

  it("remove refused leaves work unmoved", async () => {
    const w = makeWorld();
    withRollback(w.prisma);
    // The only owner holds open work; a support super-admin passes the owner
    // check, but the last-owner rule fails after the counts.
    seedWork(w, U.owner);
    const before = JSON.stringify([w.db.conversation, w.db.ticket, w.db.activity, w.db.contact, w.db.workspaceMember]);
    const err = await w.handover.removeWithHandover(WS, U.owner, { userId: "staff", isSuperAdmin: true }, U.admin).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe("A workspace must keep at least one owner");
    expect(JSON.stringify([w.db.conversation, w.db.ticket, w.db.activity, w.db.contact, w.db.workspaceMember])).toBe(before);
    expect(w.db.auditLog).toHaveLength(0);
    expect(w.notifications.notify).not.toHaveBeenCalled();
  });

  it("an admin cannot remove an owner; an impersonator cannot remove anyone", async () => {
    const w = makeWorld();
    const err = await w.handover.removeWithHandover(WS, U.owner, { userId: U.admin }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    const imp = await w.handover.removeWithHandover(WS, U.viewer, { userId: "support", impersonating: true }).catch((e) => e);
    expect(imp).toBeInstanceOf(ForbiddenException);
    expect(isMember(w, U.owner)).toBe(true);
    expect(isMember(w, U.viewer)).toBe(true);
  });

  it("a foreign member id is 404 on every handover path", async () => {
    const w = makeWorld();
    // U.other is a member of ws2 only.
    for (const run of [
      () => w.handover.openWorkFor(WS, U.other),
      () => w.handover.removeWithHandover(WS, U.other, owner),
      () => w.handover.handOverOnly(WS, U.other, U.admin, owner),
      () => w.handover.openWorkFor(WS, "nobody"),
    ]) {
      expect(await failure(run())).toMatchObject({ status: 404, body: { message: "members.not_found" } });
    }
  });
});
