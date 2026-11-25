/**
 * SP-12: the single rule for a campaign recipient's delivery state. Pure, so
 * every writer (status webhooks, phone stamping, the Zernio pull sweep, reply
 * attribution) and every reader (report, frontend `outcomeOf`) agree.
 *
 * - Status rank: queued 0 < sent 1 < failed 2 < delivered 3 < read 4 < replied 5.
 *   The new status is the higher of the current one and the event's.
 * - `skipped` is terminal: no event ever changes a skipped row.
 * - Every timestamp, `messageId`, `failureCode` and `failureReason` is written
 *   only while it is null (first write wins).
 *
 * So events are idempotent and order-independent: read-before-delivered ends
 * with status `read` and both `readAt` and `deliveredAt` set; `failed` after
 * `delivered` is ignored; `delivered` after `failed` wins and keeps the code.
 */

export const RECIPIENT_STATUSES = ["queued", "sent", "delivered", "read", "replied", "failed", "skipped"] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

/** Forward order. `skipped` is terminal and never compared (rank -1). */
export const STATUS_RANK: Record<RecipientStatus, number> = {
  skipped: -1,
  queued: 0,
  sent: 1,
  failed: 2,
  delivered: 3,
  read: 4,
  replied: 5,
};

export type RecipientEventKind = "sent" | "delivered" | "read" | "failed";

export interface RecipientEvent {
  kind: RecipientEventKind;
  /** When it happened. Null/undefined = unknown: the status still moves, no timestamp is written. */
  at?: Date | null;
  messageId?: string | null;
  failureCode?: string | null;
  failureReason?: string | null;
}

/** The mutable delivery fields of a CampaignRecipient row. */
export interface RecipientState {
  status: string;
  messageId?: string | null;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  readAt?: Date | null;
  failureCode?: string | null;
  failureReason?: string | null;
}

/** Normalized copy of the fields the merge owns (missing → null). */
export interface MergedState {
  status: string;
  messageId: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failureCode: string | null;
  failureReason: string | null;
}

const TIMESTAMP_FOR: Record<Exclude<RecipientEventKind, "failed">, "sentAt" | "deliveredAt" | "readAt"> = {
  sent: "sentAt",
  delivered: "deliveredAt",
  read: "readAt",
};

const rankOf = (s: string): number => (s in STATUS_RANK ? STATUS_RANK[s as RecipientStatus] : 0);

const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

const validDate = (d: Date | null | undefined): Date | null =>
  d instanceof Date && Number.isFinite(d.getTime()) ? d : null;

function normalize(row: RecipientState): MergedState {
  return {
    status: row.status,
    messageId: row.messageId ?? null,
    sentAt: row.sentAt ?? null,
    deliveredAt: row.deliveredAt ?? null,
    readAt: row.readAt ?? null,
    failureCode: row.failureCode ?? null,
    failureReason: row.failureReason ?? null,
  };
}

/** Apply one provider event. Returns the full next state and whether anything changed. */
export function mergeRecipientEvent(row: RecipientState, event: RecipientEvent): { next: MergedState; changed: boolean } {
  const prev = normalize(row);
  if (prev.status === "skipped") return { next: prev, changed: false };
  const next: MergedState = { ...prev };

  const eventRank = STATUS_RANK[event.kind];
  if (eventRank > rankOf(prev.status)) next.status = event.kind;

  const at = validDate(event.at);
  if (event.kind !== "failed") {
    const col = TIMESTAMP_FOR[event.kind];
    if (next[col] === null && at) next[col] = at;
  } else if (eventRank > rankOf(prev.status) || prev.status === "failed") {
    // A failure only counts while the row has not been delivered/read/replied.
    if (next.failureCode === null && event.failureCode) next.failureCode = event.failureCode;
    if (next.failureReason === null && event.failureReason) next.failureReason = event.failureReason;
  }
  if (next.messageId === null && event.messageId) next.messageId = event.messageId;

  const changed =
    next.status !== prev.status ||
    next.messageId !== prev.messageId ||
    next.failureCode !== prev.failureCode ||
    next.failureReason !== prev.failureReason ||
    !sameTime(next.sentAt, prev.sentAt) ||
    !sameTime(next.deliveredAt, prev.deliveredAt) ||
    !sameTime(next.readAt, prev.readAt);
  return { next, changed };
}

/** Fold several events (e.g. one Zernio recipient row) through the rule. */
export function mergeRecipientEvents(row: RecipientState, events: RecipientEvent[]): { next: MergedState; changed: boolean } {
  let state: RecipientState = row;
  let changed = false;
  let next = normalize(row);
  for (const e of events) {
    const r = mergeRecipientEvent(state, e);
    next = r.next;
    state = r.next;
    changed = changed || r.changed;
  }
  return { next, changed };
}

export const REPLY_TEXT_MAX = 1000;
export const BUTTON_PAYLOAD_MAX = 256;

export interface ReplyInput {
  at: Date;
  text: string | null | undefined;
  buttonPayload?: string | null;
  inboundMessageId?: string | null;
}

/**
 * The write that marks a row replied, or null when it must not change:
 * skipped rows never attribute, and the first reply wins. A `failed` row can
 * be marked replied (a reply proves the message arrived); it keeps its
 * failure code for the audit trail.
 */
export function markRepliedPatch(
  row: { status: string; repliedAt?: Date | null },
  reply: ReplyInput,
): {
  status: "replied";
  repliedAt: Date;
  replyText: string | null;
  buttonPayload: string | null;
  replyMessageId: string | null;
} | null {
  if (row.status === "skipped" || row.repliedAt) return null;
  const text = reply.text ?? null;
  const payload = reply.buttonPayload ?? null;
  return {
    status: "replied",
    repliedAt: reply.at,
    replyText: text === null ? null : text.slice(0, REPLY_TEXT_MAX),
    buttonPayload: payload === null || payload === "" ? null : payload.slice(0, BUTTON_PAYLOAD_MAX),
    replyMessageId: reply.inboundMessageId ?? null,
  };
}
