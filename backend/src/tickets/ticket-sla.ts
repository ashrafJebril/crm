/**
 * SP-09 SLA, pure. The database trigger "ticket_sla_due_at" (migration
 * 20261116120000_support_tickets) is the authority for `slaDueAt`;
 * `slaDueAtFor` mirrors it for the in-memory test doubles and previews only.
 * `slaState` is mirrored by the frontend (`src/screens/pipeline/ticketSla.ts`).
 */

/** "Due soon" window: 24 h (Tkana SLA_DUE_SOON_HOURS). */
export const SLA_DUE_SOON_MS = 24 * 60 * 60 * 1000;

export type SlaState = "none" | "finished" | "breached" | "due_soon" | "on_track";

/**
 * Due date for a ticket entering `stage` at `enteredAt`: entry + slaMinutes
 * (wall clock); null when the stage has no SLA or is terminal.
 */
export function slaDueAtFor(
  stage: { slaMinutes?: number | null; isTerminal?: boolean | null } | null | undefined,
  enteredAt: Date,
): Date | null {
  if (!stage || stage.slaMinutes == null || stage.isTerminal) return null;
  return new Date(enteredAt.getTime() + stage.slaMinutes * 60_000);
}

/**
 * - finished: the ticket sits in a terminal stage (never shown as breached);
 * - none: no due date;
 * - breached: now > slaDueAt;
 * - due_soon: due within SLA_DUE_SOON_MS (and not yet breached);
 * - on_track: otherwise.
 */
export function slaState(
  t: { slaDueAt: Date | string | null | undefined; stageIsTerminal: boolean | null | undefined },
  now: Date = new Date(),
): SlaState {
  if (t.stageIsTerminal) return "finished";
  if (t.slaDueAt == null) return "none";
  const due = (t.slaDueAt instanceof Date ? t.slaDueAt : new Date(t.slaDueAt)).getTime();
  if (Number.isNaN(due)) return "none";
  const left = due - now.getTime();
  if (left < 0) return "breached";
  if (left <= SLA_DUE_SOON_MS) return "due_soon";
  return "on_track";
}
