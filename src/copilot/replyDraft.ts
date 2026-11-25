/**
 * SP-18 "Copy to reply box": the copilot's draft waits here for the inbox
 * composer of that conversation, which takes it once (it fills the box; it
 * never sends). Kept in sessionStorage so a reload on the way still finds it;
 * every access is wrapped (blocked storage falls back to memory).
 */
const KEY = "aram.copilot.replyDraft.v1";
export const REPLY_DRAFT_EVENT = "aram:copilot-reply-draft";
const MAX_AGE_MS = 10 * 60 * 1000;

let memory: { conversationId: string; text: string; at: number } | null = null;

function store(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Leave a draft for the conversation's composer and tell an open inbox. */
export function offerReplyDraft(conversationId: string, text: string, now = Date.now()): void {
  memory = { conversationId, text, at: now };
  try {
    store()?.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* memory only */
  }
  try {
    window.dispatchEvent(new CustomEvent(REPLY_DRAFT_EVENT, { detail: { conversationId } }));
  } catch {
    /* not in a browser */
  }
}

/** The draft for this conversation, taken once (null when none, another conversation's, or stale). */
export function takeReplyDraft(conversationId: string, now = Date.now()): string | null {
  let v = memory;
  try {
    const raw = store()?.getItem(KEY);
    if (raw) v = JSON.parse(raw);
  } catch {
    /* use memory */
  }
  if (!v || v.conversationId !== conversationId || typeof v.text !== "string" || now - v.at > MAX_AGE_MS) return null;
  memory = null;
  try {
    store()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return v.text;
}
