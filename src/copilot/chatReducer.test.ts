import { describe, expect, it } from "vitest";
import type { CopilotSessionDetail, PendingCard } from "@/lib/types";
import { chatReducer, EMPTY_CHAT, pendingCards, type ChatAction, type ChatState } from "./chatReducer";

const card = (id: string, status = "PENDING"): PendingCard => ({
  id,
  tool: "move_ticket_stage",
  title: "move_ticket_stage",
  changes: [{ label: "ticket.stage", before: "New", after: "Working" }],
  status,
  expiresAt: "2026-11-17T10:30:00.000Z",
  refusal: null,
  feedback: null,
});
const ev = (event: string, data: unknown): ChatAction => ({ type: "event", event, data });
const run = (actions: ChatAction[], from: ChatState = EMPTY_CHAT) => actions.reduce(chatReducer, from);

describe("chat reducer builds messages, cards and sources from events", () => {
  it("a streamed turn", () => {
    const s = run([
      { type: "send", localId: "local-1", text: "Move it", references: [{ kind: "ticket", id: "t1", title: "#7" }], attachments: [] },
      ev("session", { sessionId: "s1", title: null }),
      ev("activity", { kind: "tool", label: "Reading tickets" }),
      ev("token", { text: "I prepared " }),
      ev("token", { text: "a card." }),
      ev("confirm", { action: card("a1") }),
      ev("draft", { conversationId: "v1", text: "Hi!" }),
      ev("sources", { items: [{ kind: "record", recordKind: "ticket", id: "t1", title: "#7" }] }),
    ]);
    expect(s.sessionId).toBe("s1");
    expect(s.running).toBe(true);
    expect(s.activity).toBe("Reading tickets");
    const done = chatReducer(s, ev("done", { messageId: "m2" }));
    expect(done.running).toBe(false);
    expect(done.activity).toBeNull();
    expect(done.items.map((i) => i.type)).toEqual(["user", "assistant", "card", "draft"]);
    expect(done.items[1]).toEqual({ type: "assistant", id: "m2", text: "I prepared a card.", sources: [{ kind: "record", recordKind: "ticket", id: "t1", title: "#7" }], streaming: false });
    expect(pendingCards(done).map((c) => c.id)).toEqual(["a1"]);
  });

  it("idempotent on replays: cards upsert, drafts and done do not duplicate", () => {
    const s = run([
      ev("token", { text: "x" }),
      ev("confirm", { action: card("a1") }),
      ev("confirm", { action: card("a1") }),
      ev("draft", { conversationId: "v1", text: "Hi" }),
      ev("draft", { conversationId: "v1", text: "Hi" }),
      ev("done", { messageId: "m1" }),
      ev("done", { messageId: "m1" }),
      ev("receipt", { action: card("a1", "EXECUTED") }),
      { type: "card", card: card("a1", "EXECUTED") },
    ]);
    expect(s.items.map((i) => i.type)).toEqual(["assistant", "card", "draft"]);
    expect(s.cards.a1.status).toBe("EXECUTED");
    expect(pendingCards(s)).toEqual([]);
  });

  it("errors end the turn: an empty bubble goes, a partial answer stays", () => {
    const empty = run([ev("activity", { label: "Thinking" }), ev("error", { code: "copilot.refused" })]);
    expect(empty.items).toEqual([{ type: "error", id: "error-0", code: "copilot.refused" }]);
    expect(empty.running).toBe(false);
    const partial = run([ev("token", { text: "Half" }), ev("error", { code: "copilot.stream_lost" })]);
    expect(partial.items.map((i) => i.type)).toEqual(["assistant", "error"]);
    expect(partial.items[0]).toMatchObject({ text: "Half", streaming: false });
    // Junk is ignored.
    expect(run([ev("token", 5), ev("confirm", { action: "x" }), ev("nope", {})])).toEqual(EMPTY_CHAT);
  });

  it("a loaded session: messages, notes, stream-error notes and its cards", () => {
    const detail: CopilotSessionDetail = {
      id: "s1",
      title: "Tickets",
      running: true,
      tainted: true,
      messages: [
        { id: "u1", role: "user", text: "hi", references: null, attachments: [{ id: "f1", fileName: "a.pdf", kind: "document" }], sources: null, createdAt: "" },
        { id: "n1", role: "note", text: "copilot.timeout", references: null, attachments: null, sources: null, createdAt: "" },
        { id: "n2", role: "note", text: "Approved and done: create_activity", references: null, attachments: null, sources: null, createdAt: "" },
        { id: "m1", role: "assistant", text: "ok", references: null, attachments: null, sources: [{ kind: "knowledge", sourceId: "k1", title: "FAQ" }], createdAt: "" },
      ],
      actions: [card("a1"), card("a2", "EXECUTED")],
    };
    const s = chatReducer(EMPTY_CHAT, { type: "load", detail });
    expect(s).toMatchObject({ sessionId: "s1", title: "Tickets", running: true, tainted: true });
    expect(s.items.map((i) => i.type)).toEqual(["user", "error", "note", "assistant", "card", "card"]);
    expect(s.items[1]).toEqual({ type: "error", id: "n1", code: "copilot.timeout" });
    // Loading twice gives the same state.
    expect(chatReducer(s, { type: "load", detail })).toEqual(s);
  });
});
