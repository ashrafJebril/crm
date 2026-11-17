/* eslint-disable @typescript-eslint/no-explicit-any */
import { AGENT, NOW, OWNER, VIEWER, WS, copilotWorld, httpError, viewer, withKey } from "./copilot-test-world";
import { MAX_REFS } from "./copilot-constants";

const dto = (references: any[]) => ({ message: "Look at these", approvalMode: "manual", lang: "en", references }) as any;

describe("CopilotRefsService", () => {
  it("@ref of record without access → refused", async () => {
    const w = copilotWorld();
    const cases: Array<[string, any[], number]> = [
      // The unassigned conversation's ticket: the assigned-only agent cannot view it (no tickets.view).
      [AGENT, [{ kind: "contact", id: "c-layla" }, { kind: "ticket", id: "t-hidden" }], 1],
      // A booking without bookings.view.
      [AGENT, [{ kind: "booking", id: "b1" }], 0],
      // A contact of another workspace.
      [OWNER, [{ kind: "contact", id: "c-layla" }, { kind: "booking", id: "b1" }, { kind: "contact", id: "c-foreign" }], 2],
      // A missing id, an empty id and an unknown kind.
      [OWNER, [{ kind: "ticket", id: "t-missing" }], 0],
      [OWNER, [{ kind: "contact", id: "" }], 0],
      [OWNER, [{ kind: "conversation", id: "v-mine" }], 0],
    ];
    for (const [user, refs, index] of cases) {
      const r = await httpError(withKey(() => w.turns.prepare(WS, viewer(user), dto(refs), NOW)));
      expect({ user, refs, r }).toEqual({ user, refs, r: { status: 403, body: { statusCode: 403, message: "copilot.ref_not_permitted", index } } });
    }
    // The fake model recorded zero calls; nothing was stored and no session was left running.
    expect(w.fake.calls).toHaveLength(0);
    expect(w.db.copilotMessage).toHaveLength(0);
    expect(w.db.copilotSession).toHaveLength(0);

    // Six references → 400 too_many_refs.
    const six = Array.from({ length: MAX_REFS + 1 }, () => ({ kind: "contact", id: "c-layla" }));
    expect(await httpError(withKey(() => w.turns.prepare(WS, viewer(OWNER), dto(six), NOW)))).toEqual({
      status: 400,
      body: { statusCode: 400, message: "copilot.too_many_refs", max: MAX_REFS },
    });
    expect(w.fake.calls).toHaveLength(0);
  });

  it("a permitted reference reaches the model as {kind, id, title, fields} in the per-turn system message", async () => {
    const w = copilotWorld();
    const t = await withKey(() => w.turn(VIEWER, { references: [{ kind: "ticket", id: "t-hidden" }, { kind: "contact", id: "c-layla" }] }));
    expect(t.last.event).toBe("done");
    const msgs = w.fake.calls[0].messages;
    const sys = msgs[msgs.length - 1];
    expect(sys.role).toBe("system");
    const json = JSON.parse(sys.content.slice(sys.content.indexOf("[{")));
    expect(json.map((r: any) => [r.kind, r.id, r.title])).toEqual([
      ["ticket", "t-hidden", "#7 · Refund for Omar"],
      ["contact", "c-layla", "Layla"],
    ]);
    expect(json[0].fields).toEqual(expect.arrayContaining([{ key: "stage", value: "New" }]));
    expect(Object.keys(json[1]).sort()).toEqual(["fields", "id", "kind", "title"]);
    // Stored on the user message (titles only, no fields).
    const user = w.db.copilotMessage.find((m) => m.role === "user");
    expect(user.references).toEqual([
      { kind: "ticket", id: "t-hidden", title: "#7 · Refund for Omar" },
      { kind: "contact", id: "c-layla", title: "Layla" },
    ]);
  });

  it("resolve: none → []", async () => {
    const w = copilotWorld();
    expect(await w.refs.resolve(WS, viewer(OWNER), undefined)).toEqual([]);
  });
});
