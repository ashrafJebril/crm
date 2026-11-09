/** SP-31 undo of an inbox stage move: shared by the undo endpoint and the
 *  thread's `undoable` flag so they can never disagree. */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;
/** Marker note written on the activity an undo creates; such a move is not itself undoable. */
export const UNDO_NOTE = "\u2063undo";
/** Only the reserved marker counts: a user-typed note "undo" is an ordinary note. */
export const isUndoNote = (note: string | null | undefined) => note === UNDO_NOTE;
/** User-typed notes never carry the reserved marker (U+2063 is stripped at the API boundary). */
export const stripReservedMarker = (note: string | undefined) => (note === undefined ? note : note.replace(/\u2063/g, ""));

export type UndoRefusal = "tickets.undo_expired" | "tickets.undo_not_latest" | "tickets.undo_not_author" | "tickets.undo_not_allowed";

export interface MoveActivityLike {
  kind: string;
  toStage: string | null;
  byUserId: string | null;
  note: string | null;
  createdAt: Date;
}

/** `latest` is the most recent move-type activity (stage_changed | won | lost) of the ticket. */
export function undoRefusal(input: {
  latest: MoveActivityLike | null;
  ticketStageKey: string;
  now: Date;
  userId: string | null | undefined;
  canManage: boolean;
  /** The stage the move came from is a terminal Lost stage: reopening a lost deal is not an undo. */
  fromStageIsLost?: boolean;
  /** The from-stage still exists in the ticket's pipeline (default true). A deleted stage cannot be moved back to. */
  fromStageExists?: boolean;
}): UndoRefusal | null {
  const { latest } = input;
  if (!latest || latest.kind !== "stage_changed" || isUndoNote(latest.note) || latest.toStage !== input.ticketStageKey) {
    return "tickets.undo_not_latest";
  }
  if (input.fromStageExists === false || input.fromStageIsLost) return "tickets.undo_not_allowed";
  if (input.now.getTime() - latest.createdAt.getTime() > UNDO_WINDOW_MS) return "tickets.undo_expired";
  if (!input.canManage && (!latest.byUserId || latest.byUserId !== input.userId)) return "tickets.undo_not_author";
  return null;
}
