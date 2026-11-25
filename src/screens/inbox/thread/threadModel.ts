import type { Tx } from "@/lib/tx";
import type { Lang, Message } from "@/lib/types";

/** The customer thread: pure model helpers (no React) so they can be unit tested. */

export type ThreadEventKind =
  | "stage_changed"
  | "ticket_created"
  | "ticket_won"
  | "ticket_lost"
  | "booking_created"
  | "booking_status"
  | "activity_done";

export type ThreadItem =
  | {
      type: "message";
      id: string;
      at: string;
      conversationId: string;
      channel: string | null;
      message: Message;
    }
  | {
      type: "seam";
      id: string;
      at: string;
      conversationId: string;
      channel: string | null;
      startedAt: string;
    }
  | {
      type: "event";
      id: string;
      at: string;
      kind: ThreadEventKind;
      ticketId?: string;
      appointmentId?: string;
      data: Record<string, unknown>;
      undoable?: boolean;
    };

export type ThreadEventItem = Extract<ThreadItem, { type: "event" }>;

export interface ThreadPage {
  /** Newest first. */
  items: ThreadItem[];
  nextBefore?: string;
}

export interface SavedReply {
  id: string;
  title: string;
  body: string;
  bodyAr: string | null;
  shortcut: string;
  createdAt: string;
  updatedAt: string;
}

export const itemKey = (i: { type: string; id: string }): string => `${i.type}:${i.id}`;

/** Append `next` after `prev`, dropping anything already present (by type+id).
 *  The first occurrence wins and order is preserved, so paging older history
 *  never reorders or duplicates what is already on screen. */
export function mergePage(prev: ThreadItem[], next: ThreadItem[]): ThreadItem[] {
  const seen = new Set<string>();
  const out: ThreadItem[] = [];
  for (const i of [...prev, ...next]) {
    const k = itemKey(i);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}

const CHANNEL_NAMES: Record<string, [string, string]> = {
  whatsapp: ["WhatsApp", "واتساب"],
  instagram: ["Instagram", "إنستغرام"],
  facebook: ["Facebook", "فيسبوك"],
  tiktok: ["TikTok", "تيك توك"],
  webchat: ["Web chat", "الدردشة على الموقع"],
  l: ["AI Agent", "الوكيل الذكي"],
};

/** Label of the seam between two conversations of one customer. */
export function seamLabel(channel: string | null | undefined, lang: Lang): string {
  if (!channel) return lang === "ar" ? "بدأت المحادثة" : "Conversation started";
  const names = CHANNEL_NAMES[channel];
  const name = names ? names[lang === "ar" ? 1 : 0] : channel;
  return lang === "ar" ? `بدأت المحادثة على ${name}` : `Conversation started on ${name}`;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): string => (typeof v === "number" || typeof v === "string" ? String(v) : "?");

const BOOKING_STATUS: Record<string, [string, string]> = {
  completed: ["completed", "اكتمل"],
  cancelled: ["cancelled", "أُلغي"],
  "no-show": ["marked no-show", "تغيّب العميل عن"],
  confirmed: ["confirmed", "تم تأكيد"],
  pending: ["pending", "قيد الانتظار"],
};

const ACTIVITY_KIND: Record<string, [string, string]> = {
  call: ["Call", "مكالمة"],
  task: ["Task", "مهمة"],
  meeting: ["Meeting", "اجتماع"],
  email: ["Email", "بريد"],
  note: ["Note", "ملاحظة"],
  whatsapp: ["WhatsApp", "واتساب"],
};

/** One-line description of a thread event, in the viewer's language. */
export function eventText(e: ThreadEventItem, tx: Tx): string {
  const d = e.data ?? {};
  const n = num(d.ticketNumber);
  const label = (en: unknown, ar: unknown): string => {
    const e1 = str(en);
    return tx(e1, str(ar) || e1);
  };
  switch (e.kind) {
    case "stage_changed": {
      if (d.isUndo === true) {
        return tx(
          `Ticket #${n} move undone, back to ${label(d.toLabel, d.toLabelAr)}`,
          `تم التراجع عن نقل التذكرة #${n}، عادت إلى ${label(d.toLabel, d.toLabelAr)}`,
        );
      }
      return tx(
        `Ticket #${n} moved from ${label(d.fromLabel, d.fromLabelAr)} to ${label(d.toLabel, d.toLabelAr)}`,
        `نُقلت التذكرة #${n} من ${label(d.fromLabel, d.fromLabelAr)} إلى ${label(d.toLabel, d.toLabelAr)}`,
      );
    }
    case "ticket_created":
      return tx(`Ticket #${n} created`, `تم إنشاء التذكرة #${n}`);
    case "ticket_won":
      return tx(`Ticket #${n} won`, `تم كسب التذكرة #${n}`);
    case "ticket_lost":
      return tx(`Ticket #${n} lost`, `خسارة التذكرة #${n}`);
    case "booking_created": {
      const s = label(d.service, d.serviceAr);
      return tx(`Booking created: ${s}`, `تم إنشاء حجز: ${s}`);
    }
    case "booking_status": {
      const s = label(d.service, d.serviceAr);
      const st = BOOKING_STATUS[str(d.status)] ?? [str(d.status), str(d.status)];
      return tx(`Booking ${st[0]}: ${s}`, `${st[1]} الحجز: ${s}`);
    }
    case "activity_done": {
      const k = ACTIVITY_KIND[str(d.activityKind)] ?? [str(d.activityKind) || "Activity", str(d.activityKind) || "نشاط"];
      const title = str(d.title);
      return tx(`${k[0]} done${title ? `: ${title}` : ""}`, `تم إنجاز ${k[1]}${title ? `: ${title}` : ""}`);
    }
    default:
      return "";
  }
}

/** Mirrors the server's 10 minute undo window; the server remains the authority. */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;

export function canUndoNow(e: { undoable?: boolean; at: string }, now: number): boolean {
  if (e.undoable !== true) return false;
  const t = Date.parse(e.at);
  if (Number.isNaN(t)) return false;
  return now - t <= UNDO_WINDOW_MS;
}

const UNDO_ERRORS: Record<string, [string, string]> = {
  "tickets.undo_expired": [
    "This move is older than 10 minutes and can no longer be undone.",
    "مرّ أكثر من 10 دقائق على هذا النقل ولم يعد التراجع عنه ممكنًا.",
  ],
  "tickets.undo_not_latest": [
    "Only the latest stage move can be undone, and the ticket has changed since.",
    "يمكن التراجع عن آخر نقل فقط، وقد تغيّرت التذكرة منذ ذلك الحين.",
  ],
  "tickets.undo_not_allowed": [
    "A move out of a Lost stage can't be undone here. Reopen the ticket from the pipeline instead.",
    "لا يمكن التراجع عن النقل من مرحلة الخسارة هنا. أعد فتح التذكرة من المسار بدلًا من ذلك.",
  ],
  "tickets.undo_not_author": [
    "Only the person who moved the ticket (or a manager) can undo this move.",
    "فقط من نقل التذكرة (أو المدير) يمكنه التراجع عن هذا النقل.",
  ],
};

/** Localized text for an undo error key, or null when the key is unknown. */
export function undoErrorText(key: string, tx: Tx): string | null {
  const m = UNDO_ERRORS[key];
  return m ? tx(m[0], m[1]) : null;
}

/** `/ho` at the very start of the composer opens the saved-replies picker.
 *  Returns the lower-cased query, or null when the picker should stay closed. */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const rest = draft.slice(1);
  if (/\s/.test(rest)) return null;
  return rest.toLowerCase();
}

/** Shortcut-prefix matches first, then shortcut/title substring matches. */
export function filterSavedReplies(replies: SavedReply[], query: string): SavedReply[] {
  const q = query.trim().toLowerCase();
  if (!q) return replies;
  const prefix = replies.filter((r) => r.shortcut.startsWith(q));
  const rest = replies.filter(
    (r) => !r.shortcut.startsWith(q) && (r.shortcut.includes(q) || r.title.toLowerCase().includes(q)),
  );
  return [...prefix, ...rest];
}

/** Body in the UI language, falling back to the other one when it is empty. */
export function pickReplyBody(r: Pick<SavedReply, "body" | "bodyAr">, lang: Lang): string {
  const en = r.body?.trim() ? r.body : "";
  const ar = r.bodyAr?.trim() ? r.bodyAr : "";
  return lang === "ar" ? ar || en : en || ar;
}
