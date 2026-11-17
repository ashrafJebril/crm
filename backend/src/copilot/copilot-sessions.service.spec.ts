/* eslint-disable @typescript-eslint/no-explicit-any */
import { ADMIN, AGENT, FOREIGN, NOW, OWNER, WS, WS2, copilotWorld, httpError, viewer, withKey } from "./copilot-test-world";
import { EARLIER_NOTE } from "./copilot-sessions.service";
import { HISTORY_PAGE, TRANSCRIPT_TURNS_SENT } from "./copilot-constants";
import { NO_ANSWER } from "./copilot-model";
import { text, toolUse } from "./fake-claude-stream";

describe("CopilotSessionsService", () => {
  it("history scoped to the member", async () => {
    const w = copilotWorld();
    // A = the agent; two sessions with one exchange each.
    const s1 = await withKey(() => w.turn(AGENT, { message: "first" }));
    const s2 = await withKey(() => w.turn(AGENT, { message: "second" }));
    expect(s1.last.event).toBe("done");
    const callsBefore = w.fake.calls.length;

    // A lists both, newest first.
    const mine = await w.controller.list(WS, viewer(AGENT));
    expect(mine.items.map((i) => i.id)).toEqual([s2.sessionId, s1.sessionId]);

    // B (same workspace, even the owner) sees none and gets 404 on every route.
    for (const b of [OWNER, ADMIN]) {
      expect((await w.controller.list(WS, viewer(b))).items).toEqual([]);
      expect(await httpError(w.controller.get(WS, viewer(b), s1.sessionId))).toMatchObject({ status: 404, body: { message: "copilot.not_found" } });
      expect(await httpError(w.controller.remove(WS, viewer(b), s1.sessionId))).toMatchObject({ status: 404 });
      expect(await httpError(withKey(() => w.turns.prepare(WS, viewer(b), { sessionId: s1.sessionId, message: "hi", approvalMode: "manual", lang: "en" } as any, NOW)))).toMatchObject({
        status: 404,
        body: { message: "copilot.not_found" },
      });
    }
    // A foreign workspace's member with A's id → 404 (and no model call).
    expect(await httpError(w.controller.get(WS2, viewer(FOREIGN), s1.sessionId))).toMatchObject({ status: 404 });
    expect(await httpError(withKey(() => w.turns.prepare(WS2, viewer(FOREIGN), { sessionId: s1.sessionId, message: "hi", approvalMode: "manual", lang: "en" } as any, NOW)))).toMatchObject({ status: 404 });
    // A's own id but the wrong workspace → 404.
    expect(await httpError(w.controller.get(WS2, viewer(AGENT), s1.sessionId))).toMatchObject({ status: 404 });
    expect(w.fake.calls.length).toBe(callsBefore);
    // Nothing was written into A's sessions.
    expect(w.db.copilotMessage.filter((m) => m.sessionId === s1.sessionId)).toHaveLength(2);

    // A's detail.
    const d = await w.controller.get(WS, viewer(AGENT), s1.sessionId);
    expect(d.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "first"],
      ["assistant", "Hello!"],
    ]);
    expect(d.running).toBe(false);

    // Delete: gone from the list, 404 afterwards.
    expect(await w.controller.remove(WS, viewer(AGENT), s1.sessionId)).toEqual({ ok: true });
    expect((await w.controller.list(WS, viewer(AGENT))).items.map((i) => i.id)).toEqual([s2.sessionId]);
    expect(await httpError(w.controller.get(WS, viewer(AGENT), s1.sessionId))).toMatchObject({ status: 404 });
    expect(await httpError(w.controller.remove(WS, viewer(AGENT), s1.sessionId))).toMatchObject({ status: 404 });
    expect(await httpError(withKey(() => w.turns.prepare(WS, viewer(AGENT), { sessionId: s1.sessionId, message: "hi", approvalMode: "manual", lang: "en" } as any, NOW)))).toMatchObject({ status: 404 });
  });

  it("paging by cursor is stable while sessions change", async () => {
    const w = copilotWorld();
    const base = NOW.getTime();
    const total = HISTORY_PAGE + 5;
    for (let i = 0; i < total; i++) {
      // Two sessions share each timestamp: the id breaks the tie.
      w.db.copilotSession.push({ id: `s${String(i).padStart(3, "0")}`, workspaceId: WS, userId: AGENT, persona: "aida", title: `t${i}`, runningUntil: null, tainted: false, deletedAt: null, createdAt: new Date(base), updatedAt: new Date(base - Math.floor(i / 2) * 1000) });
    }
    w.db.copilotSession.push({ id: "s-owner", workspaceId: WS, userId: OWNER, persona: "aida", title: "x", runningUntil: null, tainted: false, deletedAt: null, createdAt: new Date(base), updatedAt: new Date(base) });
    const p1 = await w.sessions.list(WS, AGENT);
    expect(p1.items).toHaveLength(HISTORY_PAGE);
    expect(p1.nextCursor).toBeTruthy();
    // A new session arrives at the top between pages: page 2 neither repeats nor skips.
    w.db.copilotSession.push({ id: "s-new", workspaceId: WS, userId: AGENT, persona: "aida", title: "new", runningUntil: null, tainted: false, deletedAt: null, createdAt: new Date(base + 5000), updatedAt: new Date(base + 5000) });
    const p2 = await w.sessions.list(WS, AGENT, p1.nextCursor!);
    expect(p2.nextCursor).toBeNull();
    const seen = [...p1.items, ...p2.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(total);
    expect(seen).not.toContain("s-owner");
    expect(seen).not.toContain("s-new");
    // Ordered by updatedAt desc, id desc.
    const rows = seen.map((id) => w.db.copilotSession.find((s) => s.id === id));
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      expect(a.updatedAt.getTime() > b.updatedAt.getTime() || (a.updatedAt.getTime() === b.updatedAt.getTime() && a.id > b.id)).toBe(true);
    }
    // A garbage cursor is the first page, not an error.
    expect((await w.sessions.list(WS, AGENT, "!!not-a-cursor")).items).toHaveLength(HISTORY_PAGE);
  });

  it("transcript: append-only replay; beyond the window a note and no thinking blocks", async () => {
    const w = copilotWorld();
    const s = await w.sessions.create(WS, AGENT);
    const think = { type: "thinking", thinking: "hmm", signature: "sig" };
    for (let i = 0; i < 3; i++) {
      await w.sessions.append(WS, s.id, { role: "user", text: `q${i}`, content: [{ role: "user", content: [{ type: "text", text: `q${i}` }] }] as any });
      await w.sessions.append(WS, s.id, { role: "assistant", text: `a${i}`, content: [{ role: "assistant", content: [think, { type: "text", text: `a${i}` }] }] as any });
    }
    const short = await w.sessions.transcript(WS, s.id);
    expect(short).toHaveLength(6);
    // Thinking blocks replayed unchanged within the window.
    expect((short[1].content as any[])[0]).toEqual(think);

    for (let i = 3; i < TRANSCRIPT_TURNS_SENT + 2; i++) {
      await w.sessions.append(WS, s.id, { role: "user", text: `q${i}`, content: [{ role: "user", content: [{ type: "text", text: `q${i}` }] }] as any });
      await w.sessions.append(WS, s.id, { role: "assistant", text: `a${i}`, content: [{ role: "assistant", content: [think, { type: "text", text: `a${i}` }] }] as any });
    }
    const long = await w.sessions.transcript(WS, s.id);
    expect((long[0].content as any[])[0].text).toBe(EARLIER_NOTE);
    expect(long).toHaveLength(2 + TRANSCRIPT_TURNS_SENT * 2);
    expect((long[2].content as any[])[0].text).toBe("q2");
    expect(long.some((m) => Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === "thinking"))).toBe(false);
  });

  /** The API's ordering rules for a replay: user first; a system message follows a user message and is last or followed by an assistant. */
  function assertValidReplay(msgs: any[]) {
    expect(msgs[0].role).toBe("user");
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== "system") continue;
      expect({ i, prev: msgs[i - 1]?.role }).toEqual({ i, prev: "user" });
      if (i < msgs.length - 1) expect({ i, next: msgs[i + 1].role }).toEqual({ i, next: "assistant" });
    }
    const uses = msgs.flatMap((m) => (m.role === "assistant" && Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id) : []));
    const results = msgs.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id) : []));
    expect(results.sort()).toEqual(uses.sort());
  }

  it("a session whose previous turn crashed mid-way still works on the next turn (lease taken over)", async () => {
    const w = copilotWorld({ script: [{ content: [text("second answer")] }] });
    // The first turn is prepared (user row + context stored, lease held), then the process dies: run() never happens.
    const crashed = await withKey(() => w.turns.prepare(WS, viewer(AGENT), { message: "first", approvalMode: "manual", lang: "en" } as any, NOW));
    expect(w.db.copilotSession[0].runningUntil).not.toBeNull();
    // Later than the lease: the next turn takes it over and closes the abandoned turn with a note.
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const next = await withKey(() => w.turns.prepare(WS, viewer(AGENT), { sessionId: crashed.sessionId, message: "second", approvalMode: "manual", lang: "en" } as any, later));
    const events: any[] = [];
    await withKey(() => next.run((e, d) => events.push({ e, d })));
    expect(events[events.length - 1].e).toBe("done");
    const sent = w.fake.calls[0].messages;
    assertValidReplay(sent);
    expect(sent.map((m: any) => m.role)).toEqual(["user", "system", "assistant", "user", "system"]);
    expect(sent[2].content).toEqual([{ type: "text", text: NO_ANSWER }]);
    const d = await w.sessions.detail(WS, AGENT, crashed.sessionId, later);
    expect(d.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "first"],
      ["note", "copilot.timeout"],
      ["user", "second"],
      ["assistant", "second answer"],
    ]);
  });

  it("an unfinished turn without a closing row is closed in the replay", async () => {
    const w = copilotWorld({ script: [{ content: [toolUse("t1", "get_contact", { id: "c-layla" })], stop_reason: "tool_use" }, { content: [text("ok")] }] });
    const s = await w.sessions.create(WS, AGENT);
    // Rows as a crash leaves them: a user turn with no answer, then one whose assistant asked for a tool that never ran.
    await w.sessions.append(WS, s.id, { role: "user", text: "q1", content: [{ role: "user", content: [{ type: "text", text: "q1" }] }, { role: "system", content: "ctx" }] as any });
    await w.sessions.append(WS, s.id, { role: "user", text: "q2", content: [{ role: "user", content: [{ type: "text", text: "q2" }] }] as any });
    await w.sessions.append(WS, s.id, { role: "assistant", text: "", content: [{ role: "assistant", content: [toolUse("x1", "get_contact", { id: "c-layla" })] }] as any });
    await w.sessions.append(WS, s.id, { role: "user", text: "q3", content: [{ role: "user", content: [{ type: "text", text: "q3" }] }] as any });
    const replay = await w.sessions.transcript(WS, s.id);
    assertValidReplay(replay);
    expect(replay.map((m: any) => m.role)).toEqual(["user", "system", "assistant", "user", "assistant", "user", "assistant", "user"]);
    // And a real turn on top of it goes through.
    const t = await withKey(() => w.turn(AGENT, { sessionId: s.id, message: "q4" }));
    expect(t.last.event).toBe("done");
    for (const c of w.fake.calls) assertValidReplay(c.messages);
  });

  it("the turn lease: 409 while running, free again after release or expiry", async () => {
    const w = copilotWorld();
    const s = await w.sessions.create(WS, AGENT);
    await w.sessions.acquireTurn(WS, AGENT, s.id, NOW);
    expect(await httpError(w.sessions.acquireTurn(WS, AGENT, s.id, NOW))).toMatchObject({ status: 409, body: { message: "copilot.turn_running" } });
    // Another member's attempt is 404, not 409.
    expect(await httpError(w.sessions.acquireTurn(WS, OWNER, s.id, NOW))).toMatchObject({ status: 404 });
    expect((await w.sessions.list(WS, AGENT, undefined, NOW)).items[0].running).toBe(true);
    await w.sessions.releaseTurn(WS, s.id);
    await w.sessions.acquireTurn(WS, AGENT, s.id, NOW);
    // An expired lease is free.
    await w.sessions.acquireTurn(WS, AGENT, s.id, new Date(NOW.getTime() + 60 * 60 * 1000));
  });
});
