/** SP-31 undo of an inbox stage move: shared by the undo endpoint and the
 *  thread's `undoable` flag so they can never disagree. */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;
/** Marker note written on the activity an undo creates; such a move is not itself undoable. */
export const UNDO_NOTE = "undo";

export type UndoRefusal = "tickets.undo_expired" | "tickets.undo_not_latest" | "tickets.undo_not_author";

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
}): UndoRefusal | null {
  const { latest } = input;
  if (!latest || latest.kind !== "stage_changed" || latest.note === UNDO_NOTE || latest.toStage !== input.ticketStageKey) {
    return "tickets.undo_not_latest";
  }
  if (input.now.getTime() - latest.createdAt.getTime() > UNDO_WINDOW_MS) return "tickets.undo_expired";
  if (!input.canManage && (!latest.byUserId || latest.byUserId !== input.userId)) return "tickets.undo_not_author";
  return null;
}
