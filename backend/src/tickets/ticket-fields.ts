/**
 * SP-09 ticket fields. Mirrored in `src/screens/pipeline/ticketFields.ts`
 * (a frontend test pins the key lists equal). Labels live on the client.
 */

/** Sort rank is this order: urgent first, low last. */
export const TICKET_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const DEFAULT_TICKET_PRIORITY: TicketPriority = "normal";

/** Fixed category keys (ruling 3); stored in Ticket.category, null = not set. */
export const TICKET_CATEGORIES = [
  "general_inquiry",
  "complaint",
  "service_request",
  "payment_problem",
  "execution_delay",
  "incorrect_data",
  "ticket_follow_up",
  "data_modification",
  "other",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** At most this many files on one ticket (400 tickets.attachments_full). */
export const TICKET_ATTACHMENTS_MAX = 50;

/** 0 for urgent … 3 for low; an unknown (legacy) value sorts with normal. */
export function priorityRank(p: string | null | undefined): number {
  const i = TICKET_PRIORITIES.indexOf(p as TicketPriority);
  return i >= 0 ? i : TICKET_PRIORITIES.indexOf(DEFAULT_TICKET_PRIORITY);
}

/**
 * A CSV query value (`?priority=high,urgent`) narrowed to `allowed`. Unknown
 * entries are dropped (a filter value outside the list is ignored, never a
 * 500); duplicates collapse; the result keeps `allowed` order. Returns
 * undefined when nothing valid remains, so the filter is not applied.
 */
export function parseCsvList<T extends string>(
  v: string | string[] | null | undefined,
  allowed: readonly T[],
): T[] | undefined {
  if (v == null) return undefined;
  const raw = (Array.isArray(v) ? v.join(",") : String(v))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = allowed.filter((a) => raw.includes(a));
  return out.length > 0 ? out : undefined;
}
