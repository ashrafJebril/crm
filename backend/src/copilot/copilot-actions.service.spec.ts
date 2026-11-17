/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConflictException } from "@nestjs/common";
import { FOREIGN, OWNER, WRITER, WS, WS2, copilotWorld, httpError, viewer, withKey } from "./copilot-test-world";
import { text, toolUse } from "./fake-claude-stream";
import { ACTION_TTL_MS, FEEDBACK_MAX } from "./copilot-constants";

const move = (id = "t1", stageId = "s2") => toolUse(id, "move_ticket_stage", { ticketId: "t-hidden", stageId });
const activity = (id = "a1") => toolUse(id, "create_activity", { kind: "follow_up", title: "Call Layla back", dueAt: "2026-11-18T09:00:00+03:00", contactId: "c-layla" });

/** A world where WRITER's first turn proposes `uses` (manual mode unless given). */
async function proposed(uses: any[], mode = "manual") {
  const w = copilotWorld({ script: [{ content: uses, stop_reason: "tool_use" }, { content: [text("Proposed.")] }] });
  const t = await withKey(() => w.turn(WRITER, { approvalMode: mode as any }));
  return { w, t, actions: w.db.copilotPendingAction };
}
const audits = (w: any, actionId: string) => w.db.copilotActionAudit.filter((a: any) => a.actionId === actionId).map((a: any) => a.event);

describe("CopilotActionsService", () => {
  it("approve runs exactly the sealed args through the existing service, once", async () => {
    const { w, actions } = await proposed([activity()]);
    expect(actions).toHaveLength(1);
    expect(w.activities.create).not.toHaveBeenCalled();
    const { action } = await w.controller.approve(WS, viewer(WRITER), actions[0].id);
    expect(action).toMatchObject({ id: actions[0].id, status: "EXECUTED", tool: "create_activity", refusal: null, result: { activityId: "act-1" } });
    expect(w.activities.create).toHaveBeenCalledTimes(1);
    expect(w.activities.create).toHaveBeenCalledWith(
      WS,
      { kind: "follow_up", title: "Call Layla back", dueAt: "2026-11-18T06:00:00.000Z", contactId: "c-layla" },
      WRITER,
      { userId: WRITER, bypass: false },
    );
    expect(actions[0]).toMatchObject({ decidedBy: "approved", decidedById: WRITER });
    expect(audits(w, actions[0].id)).toEqual(["PROPOSED", "APPROVED", "EXECUTED"]);
    expect(w.db.copilotMessage.filter((m) => m.role === "note").map((m) => m.text)).toEqual(["Approved and done: create_activity"]);
    // Decided once: a second approve is 409 with the status.
    expect(await httpError(w.controller.approve(WS, viewer(WRITER), actions[0].id))).toMatchObject({ status: 409, body: { message: "copilot.action_closed", status: "EXECUTED" } });
    expect(w.activities.create).toHaveBeenCalledTimes(1);
  });

  it("approval re-checks permission (role changed mid-turn → refused)", async () => {
    const { w, actions } = await proposed([move()]);
    const id = actions[0].id;
    // The owner removes tickets.update from the agent's role before the approval.
    w.setRole(WRITER, { contacts: ["view"], conversations: ["view"], tickets: ["view"] });
    expect(await httpError(w.controller.approve(WS, viewer(WRITER), id))).toEqual({ status: 403, body: { statusCode: 403, message: "copilot.permission_revoked" } });
    expect(actions[0]).toMatchObject({ status: "REJECTED", refusal: "permission_revoked" });
    expect(audits(w, id)).toEqual(["PROPOSED", "REFUSED"]);
    expect(w.db.copilotActionAudit.find((a) => a.event === "REFUSED").detail).toEqual({ refusal: "permission_revoked" });
    expect(w.db.copilotMessage.filter((m) => m.role === "note").map((m) => m.text)).toEqual(["Not done (permission_revoked): move_ticket_stage"]);
    expect(w.moveTicket).not.toHaveBeenCalled();
    // Restoring the role does not resurrect the action.
    w.setRole(WRITER, { contacts: ["view", "update"], conversations: ["view", "create"], tickets: ["view", "update"] });
    expect(await httpError(w.controller.approve(WS, viewer(WRITER), id))).toMatchObject({ status: 409, body: { message: "copilot.action_closed", status: "REJECTED" } });
    expect(w.moveTicket).not.toHaveBeenCalled();
    expect(w.db.ticket.find((t) => t.id === "t-hidden").stageId).toBe("s1");
  });

  it("a member removed from the workspace gets 404 first, and nothing changes", async () => {
    const { w, actions } = await proposed([move()]);
    w.removeMember(WRITER);
    expect(await httpError(w.controller.approve(WS, viewer(WRITER), actions[0].id))).toMatchObject({ status: 404, body: { message: "copilot.not_found" } });
    expect(await httpError(w.controller.decline(WS, viewer(WRITER), actions[0].id, {}))).toMatchObject({ status: 404 });
    expect(actions[0].status).toBe("PENDING");
    expect(w.moveTicket).not.toHaveBeenCalled();
  });

  it("another member's action id is 404 (even the owner cannot approve a member's card)", async () => {
    const { w, actions } = await proposed([move()]);
    const id = actions[0].id;
    for (const [ws, u] of [[WS, OWNER], [WS2, FOREIGN], [WS2, WRITER]] as const) {
      expect(await httpError(w.controller.approve(ws, viewer(u), id))).toMatchObject({ status: 404, body: { message: "copilot.not_found" } });
      expect(await httpError(w.controller.decline(ws, viewer(u), id, { note: "no" }))).toMatchObject({ status: 404 });
    }
    expect(actions[0].status).toBe("PENDING");
    expect(w.moveTicket).not.toHaveBeenCalled();
  });

  describe("approve and decline race is decided once", () => {
    it("concurrently: exactly one wins", async () => {
      const { w, actions } = await proposed([move()]);
      const out = await Promise.allSettled([w.controller.approve(WS, viewer(WRITER), actions[0].id), w.controller.decline(WS, viewer(WRITER), actions[0].id, { note: "wait" })]);
      expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const lost = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason.getStatus()).toBe(409);
      expect(lost.reason.getResponse().message).toBe("copilot.action_closed");
      if (actions[0].status === "EXECUTED") expect(w.moveTicket).toHaveBeenCalledTimes(1);
      else {
        expect(actions[0]).toMatchObject({ status: "REJECTED", refusal: "declined" });
        expect(w.moveTicket).not.toHaveBeenCalled();
      }
    });

    it("decline then approve: the approve is 409 and nothing runs", async () => {
      const { w, actions } = await proposed([move()]);
      await w.controller.decline(WS, viewer(WRITER), actions[0].id, { note: "Not yet" });
      expect(await httpError(w.controller.approve(WS, viewer(WRITER), actions[0].id))).toMatchObject({ status: 409, body: { status: "REJECTED" } });
      expect(w.moveTicket).not.toHaveBeenCalled();
    });

    it("approve then decline: the decline is 409", async () => {
      const { w, actions } = await proposed([move()]);
      await w.controller.approve(WS, viewer(WRITER), actions[0].id);
      expect(await httpError(w.controller.decline(WS, viewer(WRITER), actions[0].id, {}))).toMatchObject({ status: 409, body: { status: "EXECUTED" } });
      expect(w.moveTicket).toHaveBeenCalledTimes(1);
    });

    it("a guarded update that loses after the checks is 409, not a second run", async () => {
      const { w, actions } = await proposed([move()]);
      // The decline lands between the approval's checks and its guarded update.
      const recheck = w.registry.get("move_ticket_stage")!.recheck!;
      jest.spyOn(w.registry.get("move_ticket_stage")!, "recheck").mockImplementationOnce(async (exec, args) => {
        const r = await recheck(exec, args);
        await w.controller.decline(WS, viewer(WRITER), actions[0].id, {});
        return r;
      });
      expect(await httpError(w.controller.approve(WS, viewer(WRITER), actions[0].id))).toMatchObject({ status: 409, body: { message: "copilot.action_closed", status: "REJECTED" } });
      expect(w.moveTicket).not.toHaveBeenCalled();
    });
  });

  it("stale card is refused as card_outdated", async () => {
    const { w, actions } = await proposed([move()]);
    // Someone moved the ticket after the card was made.
    w.db.ticket.find((t) => t.id === "t-hidden").stageId = "s-won";
    expect(await httpError(w.controller.approve(WS, viewer(WRITER), actions[0].id))).toEqual({ status: 409, body: { statusCode: 409, message: "copilot.card_outdated" } });
    expect(actions[0]).toMatchObject({ status: "REJECTED", refusal: "card_outdated" });
    expect(w.moveTicket).not.toHaveBeenCalled();
    // A move racing the approval (the service's expectStageId conflict) is the same refusal, nothing written.
    const p = await proposed([move()]);
    p.w.moveTicket.mockImplementationOnce(async () => {
      throw new ConflictException("tickets.undo_not_latest");
    });
    expect(await httpError(p.w.controller.approve(WS, viewer(WRITER), p.actions[0].id))).toMatchObject({ status: 409, body: { message: "copilot.card_outdated" } });
    expect(p.actions[0]).toMatchObject({ status: "REJECTED", refusal: "card_outdated" });
    expect(audits(p.w, p.actions[0].id)).toEqual(["PROPOSED", "APPROVED", "REFUSED"]);
    expect(p.w.db.ticket.find((t) => t.id === "t-hidden").stageId).toBe("s1");
  });

  it("expired action is 410 and never executes", async () => {
    const { w, actions } = await proposed([activity()]);
    const later = new Date(actions[0].expiresAt.getTime() + 1);
    expect(actions[0].expiresAt.getTime() - actions[0].createdAt.getTime()).toBeGreaterThanOrEqual(ACTION_TTL_MS - 1000);
    expect(await httpError(w.actions.approve(WS, viewer(WRITER), actions[0].id, later))).toEqual({ status: 410, body: { statusCode: 410, message: "copilot.action_expired" } });
    expect(actions[0].status).toBe("EXPIRED");
    expect(audits(w, actions[0].id)).toEqual(["PROPOSED", "EXPIRED"]);
    expect(await httpError(w.actions.approve(WS, viewer(WRITER), actions[0].id, later))).toMatchObject({ status: 409, body: { status: "EXPIRED" } });
    expect(await httpError(w.actions.decline(WS, viewer(WRITER), actions[0].id, "x", later))).toMatchObject({ status: 409 });
    expect(w.activities.create).not.toHaveBeenCalled();
  });

  it("args tampering is refused (hash mismatch)", async () => {
    const { w, actions } = await proposed([move()]);
    // The stored row is changed after the member saw the card.
    actions[0].argsJson = { ...actions[0].argsJson, stageId: "s-lost" };
    expect(await httpError(w.controller.approve(WS, viewer(WRITER), actions[0].id))).toMatchObject({ status: 409, body: { message: "copilot.card_outdated" } });
    expect(actions[0]).toMatchObject({ status: "REJECTED", refusal: "card_outdated" });
    expect(w.moveTicket).not.toHaveBeenCalled();
  });

  it("decline stores the note, runs nothing; a note over FEEDBACK_MAX is 400", async () => {
    const { w, actions } = await proposed([activity()]);
    expect(await httpError(w.controller.decline(WS, viewer(WRITER), actions[0].id, { note: "x".repeat(FEEDBACK_MAX + 1) }))).toMatchObject({
      status: 400,
      body: { message: "copilot.feedback_too_long", max: FEEDBACK_MAX },
    });
    const { action } = await w.controller.decline(WS, viewer(WRITER), actions[0].id, { note: "  Use Thursday instead " });
    expect(action).toMatchObject({ status: "REJECTED", refusal: "declined", feedback: "Use Thursday instead" });
    expect(audits(w, actions[0].id)).toEqual(["PROPOSED", "REJECTED"]);
    // The audit keeps no member or customer text.
    expect(JSON.stringify(w.db.copilotActionAudit)).not.toContain("Thursday");
    expect(w.activities.create).not.toHaveBeenCalled();
  });

  it("a write the member's role does not allow makes no card (tool refusal)", async () => {
    const w = copilotWorld({ script: [{ content: [move()], stop_reason: "tool_use" }, { content: [text("no")] }] });
    const { VIEWER } = await import("./copilot-test-world");
    const t = await withKey(() => w.turn(VIEWER, {}));
    expect(w.db.copilotPendingAction).toHaveLength(0);
    expect(t.events.some((e) => e.event === "confirm")).toBe(false);
    const msgs = w.fake.calls[1].messages;
    expect(JSON.parse(msgs[msgs.length - 1].content[0].content)).toMatchObject({ error: "no_access", permission: "tickets.update" });
  });
});
