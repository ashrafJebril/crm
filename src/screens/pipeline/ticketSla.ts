import type { Tx } from "@/lib/tx";
import { safeTz } from "@/screens/followups/followupsLogic";
import { priorityChipShown, type Tone } from "./ticketFields";

/**
 * SP-09 SLA, pure. Mirror of backend/src/tickets/ticket-sla.ts `slaState`:
 * the database sets `slaDueAt` on stage entry; the client only classifies it.
 */

/** "Due soon" window: 24 h. */
export const SLA_DUE_SOON_MS = 24 * 60 * 60 * 1000;

export type SlaState = "none" | "finished" | "breached" | "due_soon" | "on_track";

/**
 * - finished: the ticket sits in a terminal stage (never shown as breached);
 * - none: no due date;
 * - breached: now > slaDueAt (exactly at slaDueAt is not yet overdue);
 * - due_soon: due within 24 h (inclusive);
 * - on_track: otherwise.
 */
export function slaState(
  t: { slaDueAt: Date | string | null | undefined; stageIsTerminal: boolean | null | undefined },
  now: Date = new Date(),
): SlaState {
  if (t.stageIsTerminal) return "finished";
  if (t.slaDueAt == null || t.slaDueAt === "") return "none";
  const due = (t.slaDueAt instanceof Date ? t.slaDueAt : new Date(t.slaDueAt)).getTime();
  if (Number.isNaN(due)) return "none";
  const left = due - now.getTime();
  if (left < 0) return "breached";
  if (left <= SLA_DUE_SOON_MS) return "due_soon";
  return "on_track";
}

/** A ticket's SLA state from what a list row or card knows: its stage, else closedAt. */
export function ticketSlaState(
  t: { slaDueAt?: string | null; closedAt?: string | null; stage?: { isTerminal: boolean } | null },
  stageIsTerminal: boolean | undefined,
  now: Date = new Date(),
): SlaState {
  const terminal = stageIsTerminal ?? t.stage?.isTerminal ?? !!t.closedAt;
  return slaState({ slaDueAt: t.slaDueAt, stageIsTerminal: terminal }, now);
}

/** "16 Nov, 14:30" in the workspace timezone, Latin digits in both languages (SP-04). */
export function formatSlaDue(slaDueAt: Date | string, tz: string, tx: Tx): string {
  const d = slaDueAt instanceof Date ? slaDueAt : new Date(slaDueAt);
  if (Number.isNaN(d.getTime())) return "—";
  const locale = tx("en-GB", "ar-SA-u-nu-latn");
  return new Intl.DateTimeFormat(locale, {
    timeZone: safeTz(tz),
    calendar: "gregory",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

export interface SlaBadge {
  state: SlaState;
  /** Short badge text. */
  label: string;
  /** The due time alone (for a separate `<bdi>`), or null. */
  due: string | null;
  /** Full sentence for a tooltip / screen readers. */
  title: string;
  tone: Tone;
}

/** Badge for a state; null for a terminal (finished) ticket, which shows no badge. */
export function slaBadge(state: SlaState, slaDueAt: Date | string | null | undefined, tz: string, tx: Tx): SlaBadge | null {
  if (state === "finished") return null;
  const due = slaDueAt ? formatSlaDue(slaDueAt, tz, tx) : null;
  const dueSentence = due ? tx(`Due ${due}`, `تستحق ${due}`) : "";
  switch (state) {
    case "none":
      return { state, label: tx("No SLA", "بلا مهلة"), due: null, title: tx("No SLA", "بلا مهلة"), tone: "muted" };
    case "breached":
      return { state, label: tx("Overdue", "متأخرة"), due, title: [tx("Overdue", "متأخرة"), dueSentence].filter(Boolean).join(" · "), tone: "bad" };
    case "due_soon":
      return { state, label: tx("Due soon", "تستحق قريبًا"), due, title: [tx("Due soon", "تستحق قريبًا"), dueSentence].filter(Boolean).join(" · "), tone: "warn" };
    case "on_track":
      return { state, label: dueSentence, due, title: dueSentence, tone: "info" };
  }
}

/**
 * Final review I1 (controller ruling): the SLA is a support feature. The
 * chip, the table column, the drawer line and the `sla` filter show only on
 * pipelines of kind `support`; the database still computes slaDueAt for all.
 */
export function slaShownFor(kind: string | null | undefined): boolean {
  return kind === "support";
}

/** What a board card shows in its support row: the row at all, and the SLA state when the SLA is shown. */
export function cardSupportBits(
  t: { slaDueAt?: string | null; closedAt?: string | null; stage?: { isTerminal: boolean } | null; priority?: string | null; attachmentCount?: number | null },
  stageIsTerminal: boolean | undefined,
  showSla: boolean,
  now: Date = new Date(),
): { show: boolean; sla: SlaState | null } {
  const sla = showSla ? ticketSlaState(t, stageIsTerminal, now) : null;
  const slaChip = sla !== null && sla !== "finished" && sla !== "none";
  return { show: priorityChipShown(t.priority as never) || slaChip || !!t.attachmentCount, sla };
}
