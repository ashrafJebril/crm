/**
 * SP-18 card wording (pure): tool titles, change labels and values, the
 * status line, and where a receipt links. Values that came from records
 * (names, titles) are plain strings rendered as text by React.
 */
import type { Tx } from "@/lib/tx";
import type { PendingCard } from "@/lib/types";
import { copilotKeyText } from "./copilotErrors";

const TOOL_TITLES: Record<string, [string, string]> = {
  create_activity: ["Create an activity", "إنشاء نشاط"],
  move_ticket_stage: ["Move a ticket", "نقل تذكرة"],
  save_attachment_to_knowledge: ["Save a file to your knowledge", "حفظ ملف في المعرفة"],
};
const LABELS: Record<string, [string, string]> = {
  "activity.kind": ["Type", "النوع"],
  "activity.title": ["Title", "العنوان"],
  "activity.dueAt": ["Due", "الموعد"],
  "activity.contact": ["Customer", "العميل"],
  "activity.ticket": ["Ticket", "التذكرة"],
  ticket: ["Ticket", "التذكرة"],
  "ticket.stage": ["Stage", "المرحلة"],
  "ticket.note": ["Note", "ملاحظة"],
  "knowledge.file": ["File", "الملف"],
};
const KINDS: Record<string, [string, string]> = {
  follow_up: ["Follow-up", "متابعة"],
  call: ["Call", "مكالمة"],
  meeting: ["Meeting", "اجتماع"],
  task: ["Task", "مهمة"],
  note_log: ["Note", "ملاحظة"],
};

export const toolTitle = (tool: string, tx: Tx) => {
  const t = TOOL_TITLES[tool];
  return t ? tx(t[0], t[1]) : tool;
};
export const changeLabel = (label: string, tx: Tx) => {
  const l = LABELS[label];
  return l ? tx(l[0], l[1]) : label;
};

/** A change value for display: activity kinds translated, ISO times local with Latin digits. */
export function changeValue(label: string, value: string, tx: Tx, lang: "en" | "ar"): string {
  if (label === "activity.kind" && KINDS[value]) return tx(KINDS[value][0], KINDS[value][1]);
  if (label === "activity.dueAt") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString(lang === "ar" ? "ar-u-nu-latn" : "en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    }
  }
  return value;
}

/** The line under a decided card. Null while it waits. */
export function cardStatusText(c: PendingCard, tx: Tx, now = Date.now()): string | null {
  if (c.status === "PENDING") return new Date(c.expiresAt).getTime() <= now ? tx("Expired", "انتهت الصلاحية") : null;
  if (c.status === "EXECUTING") return tx("Applying…", "جارٍ التطبيق…");
  if (c.status === "EXECUTED") return tx("Done", "تم");
  if (c.status === "EXPIRED") return tx("Expired", "انتهت الصلاحية");
  if (c.status === "FAILED") return copilotKeyText(c.errorKey && c.errorKey.startsWith("copilot.") ? c.errorKey : "copilot.action_failed", tx);
  if (c.status === "REJECTED") {
    if (c.refusal === "permission_revoked") return copilotKeyText("copilot.permission_revoked", tx);
    if (c.refusal === "card_outdated") return copilotKeyText("copilot.card_outdated", tx);
    return tx("Declined", "مرفوض");
  }
  return null;
}

/** Where a receipt opens: the record the change was made on. */
export function receiptTarget(c: PendingCard): { kind: "ticket" | "contact"; id: string } | { href: string } | null {
  if (c.status !== "EXECUTED" || !c.result || typeof c.result !== "object") return null;
  const r = c.result as Record<string, unknown>;
  if (typeof r.ticketId === "string") return { kind: "ticket", id: r.ticketId };
  if (typeof r.contactId === "string") return { kind: "contact", id: r.contactId };
  if (typeof r.sourceId === "string") return { href: "#/agent" };
  return null;
}

/** The session notes the backend writes for decisions ("Approved and done: <tool>", …), in the member's language. */
export function noteText(text: string, tx: Tx): string {
  const m = /^(Approved and done|Declined|Failed|Status unknown|Not done \((permission_revoked|card_outdated)\)): ([a-z_]+)$/.exec(text);
  if (!m) return text;
  const tool = toolTitle(m[3], tx);
  if (m[1] === "Approved and done") return tx(`Approved and done: ${tool}`, `تمت الموافقة والتنفيذ: ${tool}`);
  if (m[1] === "Declined") return tx(`Declined: ${tool}`, `مرفوض: ${tool}`);
  if (m[1] === "Failed") return tx(`Couldn't be done: ${tool}`, `تعذّر التنفيذ: ${tool}`);
  if (m[1] === "Status unknown") return `${tool}: ${copilotKeyText("copilot.action_unknown", tx)}`;
  return `${tool}: ${copilotKeyText(`copilot.${m[2]}`, tx)}`;
}
