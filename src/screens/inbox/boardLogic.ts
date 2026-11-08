import type { Conversation } from "../../lib/types";

export type BoardColumn = "human" | "pending_customer" | "escalated" | "resolved" | "closed";

export const BOARD_COLUMNS: BoardColumn[] = [
  "human", "pending_customer", "escalated", "resolved", "closed",
];

/** Escalated takes precedence over status; spam has no column (returns null). */
export function boardColumnOf(c: Pick<Conversation, "status" | "escalated">): BoardColumn | null {
  if (c.escalated === true) return "escalated";
  return c.status === "spam" ? null : c.status;
}

export type BoardMove =
  | { kind: "noop" }
  | { kind: "escalate" }
  | { kind: "patch"; body: Record<string, unknown> };

/** What dropping `c` on `target` should do. Leaving Escalated clears the flag in the same PATCH. */
export function planBoardMove(
  c: Pick<Conversation, "status" | "escalated">,
  target: BoardColumn,
): BoardMove {
  if (boardColumnOf(c) === target) return { kind: "noop" };
  if (target === "escalated") return { kind: "escalate" };
  return c.escalated === true
    ? { kind: "patch", body: { escalated: false, status: target } }
    : { kind: "patch", body: { status: target } };
}

export function groupByColumn<T extends Pick<Conversation, "status" | "escalated">>(
  list: T[],
): Record<BoardColumn, T[]> {
  const out: Record<BoardColumn, T[]> = {
    human: [], pending_customer: [], escalated: [], resolved: [], closed: [],
  };
  for (const c of list) {
    const col = boardColumnOf(c);
    if (col) out[col].push(c);
  }
  return out;
}

/** Unique contact ids of stored (non-live) conversations; live threads and blank ids are skipped. */
export function groupContactIds(
  list: Pick<Conversation, "id" | "contactId">[],
  isLive: (c: { id: string }) => boolean,
): string[] {
  const seen = new Set<string>();
  for (const c of list) if (!isLive(c) && c.contactId) seen.add(c.contactId);
  return [...seen];
}


export function statusLabels(tx: (en: string, ar: string) => string): Record<Conversation["status"], string> {
  return {
    human: tx("Open", "مفتوحة"),
    pending_customer: tx("Pending customer", "بانتظار العميل"),
    resolved: tx("Resolved", "محلولة"),
    closed: tx("Closed", "مغلقة"),
    spam: tx("Spam", "مزعجة"),
  };
}
