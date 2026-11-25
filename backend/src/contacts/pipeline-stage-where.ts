import type { Prisma } from "@prisma/client";

/**
 * SP-16 ruling 9: the ONE pipeline-stage predicate, shared by the contacts
 * list filter (`buildContactWhere`) and the audience compiler
 * (`pipeline_stage` rules), so both select the same contacts.
 *
 * - With `stageId`: any card currently in that stage, open or closed (so
 *   "in Won" finds the won cards, which are closed).
 * - Pipeline only: open cards (`closedAt: null`) of that pipeline.
 *
 * Every ticket predicate carries `workspaceId`. The audience compiler checks
 * the pipeline and stage against the workspace before calling this (a
 * missing or archived one matches nobody there); the list filter does not.
 */
export function pipelineStageWhere(
  ws: string,
  ref: { pipelineId: string; stageId?: string },
  op: "in" | "not_in",
): Prisma.ContactWhereInput {
  const ticket: Prisma.TicketWhereInput = ref.stageId
    ? { workspaceId: ws, pipelineId: ref.pipelineId, stageId: ref.stageId }
    : { workspaceId: ws, pipelineId: ref.pipelineId, closedAt: null };
  return { tickets: op === "in" ? { some: ticket } : { none: ticket } };
}
