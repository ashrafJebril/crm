/**
 * SP-18 drawer state (pure): stream events and loaded sessions → the list
 * the drawer renders. Cards, drafts, sources and `done` are idempotent (a
 * replayed or re-loaded event never duplicates them); a stream that ends in
 * an error drops the empty answer bubble and shows the error line.
 */
import type { CopilotAttachmentInfo, CopilotMessage, CopilotSessionDetail, CopilotSourceCard, PendingCard } from "@/lib/types";

export type ChatItem =
  | { type: "user"; id: string; text: string; references: { kind: string; id: string; title: string }[]; attachments: CopilotAttachmentInfo[] }
  | { type: "assistant"; id: string; text: string; sources: CopilotSourceCard[]; streaming: boolean }
  | { type: "note"; id: string; text: string }
  | { type: "error"; id: string; code: string }
  | { type: "card"; id: string }
  | { type: "draft"; id: string; conversationId: string; text: string };

export interface ChatState {
  sessionId: string | null;
  title: string | null;
  items: ChatItem[];
  cards: Record<string, PendingCard>;
  /** The current activity line ("Reading tickets…"), null when idle. */
  activity: string | null;
  /** A turn is in flight (streaming here, or running on the server after a lost stream). */
  running: boolean;
  tainted: boolean;
}

export type ChatAction =
  | { type: "reset" }
  | { type: "load"; detail: CopilotSessionDetail }
  | { type: "send"; localId: string; text: string; references: { kind: string; id: string; title: string }[]; attachments: CopilotAttachmentInfo[] }
  | { type: "event"; event: string; data: unknown }
  | { type: "card"; card: PendingCard }
  | { type: "taint" }
  /** A send refused before its stream started: nothing was stored, the message goes back. */
  | { type: "unsend"; localId: string };

export const EMPTY_CHAT: ChatState = { sessionId: null, title: null, items: [], cards: {}, activity: null, running: false, tainted: false };

const STREAMING_ID = "streaming";

function fromMessage(m: CopilotMessage): ChatItem {
  if (m.role === "user") return { type: "user", id: m.id, text: m.text, references: m.references ?? [], attachments: m.attachments ?? [] };
  if (m.role === "assistant") return { type: "assistant", id: m.id, text: m.text, sources: m.sources ?? [], streaming: false };
  // A failed turn's note carries its stream error code; decision notes are plain lines.
  if (/^copilot\.[a-z_]+$/.test(m.text)) return { type: "error", id: m.id, code: m.text };
  return { type: "note", id: m.id, text: m.text };
}

function upsertCard(s: ChatState, card: PendingCard): ChatState {
  const items = s.items.some((i) => i.type === "card" && i.id === card.id) ? s.items : [...s.items, { type: "card" as const, id: card.id }];
  return { ...s, items, cards: { ...s.cards, [card.id]: card } };
}

/** The bubble being streamed (created on demand). */
function withStreaming(s: ChatState, f: (a: Extract<ChatItem, { type: "assistant" }>) => Extract<ChatItem, { type: "assistant" }>): ChatState {
  const i = s.items.findIndex((x) => x.type === "assistant" && x.streaming);
  if (i === -1) return { ...s, items: [...s.items, f({ type: "assistant", id: STREAMING_ID, text: "", sources: [], streaming: true })] };
  const items = [...s.items];
  items[i] = f(items[i] as Extract<ChatItem, { type: "assistant" }>);
  return { ...s, items };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case "reset":
      return EMPTY_CHAT;
    case "load": {
      const d = a.detail;
      let next: ChatState = { ...EMPTY_CHAT, sessionId: d.id, title: d.title, running: d.running, tainted: d.tainted, items: d.messages.map(fromMessage) };
      for (const c of d.actions) next = upsertCard(next, c);
      return next;
    }
    case "send":
      return {
        ...s,
        running: true,
        activity: null,
        items: [...s.items, { type: "user", id: a.localId, text: a.text, references: a.references, attachments: a.attachments }],
      };
    case "card":
      return upsertCard(s, a.card);
    case "taint":
      return { ...s, tainted: true };
    case "unsend":
      return { ...s, running: false, activity: null, items: s.items.filter((i) => !(i.type === "user" && i.id === a.localId)) };
    case "event": {
      const d = isObj(a.data) ? a.data : {};
      switch (a.event) {
        case "session":
          return { ...s, sessionId: typeof d.sessionId === "string" ? d.sessionId : s.sessionId, title: typeof d.title === "string" ? d.title : s.title, running: true };
        case "activity":
          return { ...s, activity: typeof d.label === "string" ? d.label : null };
        case "token":
          return typeof d.text === "string" ? withStreaming(s, (m) => ({ ...m, text: m.text + d.text })) : s;
        case "confirm":
        case "receipt":
          return isObj(d.action) && typeof d.action.id === "string" ? upsertCard(s, d.action as unknown as PendingCard) : s;
        case "draft": {
          if (typeof d.conversationId !== "string" || typeof d.text !== "string") return s;
          if (s.items.some((i) => i.type === "draft" && i.conversationId === d.conversationId && i.text === d.text)) return s;
          return { ...s, items: [...s.items, { type: "draft", id: `draft-${s.items.length}`, conversationId: d.conversationId, text: d.text }] };
        }
        case "sources":
          return Array.isArray(d.items) ? withStreaming(s, (m) => ({ ...m, sources: d.items as CopilotSourceCard[] })) : s;
        case "done": {
          const id = typeof d.messageId === "string" ? d.messageId : STREAMING_ID;
          if (s.items.some((i) => i.type === "assistant" && i.id === id && !i.streaming)) return { ...s, running: false, activity: null };
          const i = s.items.findIndex((x) => x.type === "assistant" && x.streaming);
          if (i === -1) return { ...s, running: false, activity: null };
          const items = [...s.items];
          items[i] = { ...(items[i] as Extract<ChatItem, { type: "assistant" }>), id, streaming: false };
          return { ...s, items, running: false, activity: null };
        }
        case "error": {
          const code = typeof d.code === "string" ? d.code : "copilot.ai_failed";
          // Keep a partial answer (marked done); drop an empty bubble.
          const items = s.items
            .filter((x) => !(x.type === "assistant" && x.streaming && !x.text))
            .map((x) => (x.type === "assistant" && x.streaming ? { ...x, streaming: false } : x));
          return { ...s, items: [...items, { type: "error", id: `error-${items.length}`, code }], running: false, activity: null };
        }
        default:
          return s;
      }
    }
  }
}

/** Cards still waiting for the member. */
export function pendingCards(s: ChatState): PendingCard[] {
  return Object.values(s.cards).filter((c) => c.status === "PENDING");
}
