import type { Tx } from "@/lib/tx";
import type { TicketCategory, TicketPriority } from "@/lib/types";

/**
 * SP-09 ticket fields. Mirror of backend/src/tickets/ticket-fields.ts; a test
 * pins the key lists equal by reading the backend file. Labels live here.
 */

/** Sort rank is this order: urgent first, low last. */
export const TICKET_PRIORITIES: readonly TicketPriority[] = ["urgent", "high", "normal", "low"];
export const DEFAULT_TICKET_PRIORITY: TicketPriority = "normal";

export const TICKET_CATEGORIES: readonly TicketCategory[] = [
  "general_inquiry",
  "complaint",
  "service_request",
  "payment_problem",
  "execution_delay",
  "incorrect_data",
  "ticket_follow_up",
  "data_modification",
  "other",
];

/** At most this many files on one ticket (400 tickets.attachments_full). */
export const TICKET_ATTACHMENTS_MAX = 50;

export type Tone = "bad" | "warn" | "info" | "muted";

export const PRIORITY_COPY: Record<TicketPriority, { en: string; ar: string; tone: Tone }> = {
  urgent: { en: "Urgent", ar: "عاجلة", tone: "bad" },
  high: { en: "High", ar: "مرتفعة", tone: "warn" },
  normal: { en: "Normal", ar: "عادية", tone: "muted" },
  low: { en: "Low", ar: "منخفضة", tone: "muted" },
};

export const CATEGORY_COPY: Record<TicketCategory, { en: string; ar: string }> = {
  general_inquiry: { en: "General inquiry", ar: "استفسار عام" },
  complaint: { en: "Complaint", ar: "شكوى" },
  service_request: { en: "Service request", ar: "طلب خدمة" },
  payment_problem: { en: "Payment problem", ar: "مشكلة في الدفع" },
  execution_delay: { en: "Execution delay", ar: "تأخر في التنفيذ" },
  incorrect_data: { en: "Incorrect data", ar: "بيانات غير صحيحة" },
  ticket_follow_up: { en: "Ticket follow-up", ar: "متابعة تذكرة" },
  data_modification: { en: "Data change", ar: "تعديل بيانات" },
  other: { en: "Other", ar: "أخرى" },
};

export const isPriority = (v: unknown): v is TicketPriority =>
  typeof v === "string" && (TICKET_PRIORITIES as readonly string[]).includes(v);
export const isCategory = (v: unknown): v is TicketCategory =>
  typeof v === "string" && (TICKET_CATEGORIES as readonly string[]).includes(v);

/** A ticket's priority; a missing or unknown (legacy) value reads as normal, like the backend. */
export function ticketPriority(v: unknown): TicketPriority {
  return isPriority(v) ? v : DEFAULT_TICKET_PRIORITY;
}

export function priorityLabel(tx: Tx, p: unknown): string {
  const c = PRIORITY_COPY[ticketPriority(p)];
  return tx(c.en, c.ar);
}

export function priorityTone(p: unknown): Tone {
  return PRIORITY_COPY[ticketPriority(p)].tone;
}

/** Only high and urgent earn a chip on the card; normal and low stay quiet. */
export function priorityChipShown(p: unknown): boolean {
  const v = ticketPriority(p);
  return v === "urgent" || v === "high";
}

/** Label for a category key; null when not set; an unknown key is shown as-is. */
export function categoryLabel(tx: Tx, c: unknown): string | null {
  if (c == null || c === "") return null;
  if (isCategory(c)) return tx(CATEGORY_COPY[c].en, CATEGORY_COPY[c].ar);
  return typeof c === "string" ? c : null;
}

export const TONE_COLOR: Record<Tone, string> = {
  bad: "var(--bad, #ef4444)",
  warn: "var(--warn, #f59e0b)",
  info: "var(--info, #3b82f6)",
  muted: "var(--ink-3)",
};

const CHANNEL_COPY: Record<string, { en: string; ar: string }> = {
  whatsapp: { en: "WhatsApp", ar: "واتساب" },
  instagram: { en: "Instagram", ar: "إنستغرام" },
  facebook: { en: "Facebook", ar: "فيسبوك" },
  tiktok: { en: "TikTok", ar: "تيك توك" },
  webchat: { en: "Web chat", ar: "دردشة الموقع" },
  telegram: { en: "Telegram", ar: "تيليجرام" },
  l: { en: "AI Agent", ar: "الوكيل الذكي" },
};

/** The derived channel chip text ("WhatsApp · Main line"); null when the ticket has none. */
export function channelLabel(
  tx: Tx,
  channel: { kind: string; displayName?: string | null } | null | undefined,
): string | null {
  if (!channel || !channel.kind) return null;
  const c = CHANNEL_COPY[channel.kind];
  const kind = c ? tx(c.en, c.ar) : channel.kind;
  const name = channel.displayName?.trim();
  return name && name !== kind ? `${kind} · ${name}` : kind;
}
