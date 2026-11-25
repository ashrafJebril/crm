import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import type { MoveTicketDto } from "../../tickets/tickets.dto";
import { CardOutdated, WRITE_EXECUTE, type CopilotTool, type ExecContext, type Recheck, type ToolContext, type ToolRefusal, type WriteProposal } from "./registry";
import { refusal, type WriteToolDeps } from "./write-deps";

type Input = { ticketId: string; stageId: string; note?: string; lostReasonId?: string };

async function canOpen(deps: WriteToolDeps, ws: string, viewer: ExecContext["viewer"], ticketId: string): Promise<boolean> {
  try {
    await deps.records.get(ws, viewer, "ticket", ticketId);
    return true;
  } catch {
    return false;
  }
}

/**
 * SP-18 `move_ticket_stage`: medium risk, HIGH for a terminal stage (won or
 * lost), which always needs the member's click (ruling 3). The card seals the
 * stage the ticket was in (`fromStageId`): at approval a ticket that moved
 * since is `card_outdated`, and TicketsService.moveTicket runs with
 * `expectStageId` so a move racing the approval loses cleanly.
 */
export function moveTicketStageTool(deps: WriteToolDeps): CopilotTool {
  return {
    name: "move_ticket_stage",
    description:
      "Propose moving a ticket to another stage of its pipeline (stageId). A lost stage needs a reason (note or lostReasonId). Nothing moves until the member approves the card, unless their approval mode applies it (never for won or lost).",
    inputSchema: z.object({
      ticketId: z.string().min(1).max(64),
      stageId: z.string().min(1).max(64),
      note: z.string().trim().max(2000).optional(),
      lostReasonId: z.string().min(1).max(64).optional(),
    }),
    kind: "write",
    permissions: ["tickets.update"],
    risk: "medium",
    label: ["Preparing a stage move", "تجهيز نقل مرحلة"],
    execute: WRITE_EXECUTE,
    async propose(ctx: ToolContext, input: Input): Promise<WriteProposal | ToolRefusal> {
      if (!(await canOpen(deps, ctx.workspaceId, ctx.viewer, input.ticketId))) {
        return refusal("not_found", "No ticket with that id is available to this member.");
      }
      const ticket = await deps.prisma.ticket.findFirst({
        where: { id: input.ticketId, workspaceId: ctx.workspaceId },
        select: { id: true, number: true, title: true, pipelineId: true, stageId: true, stage: { select: { label: true } } },
      });
      if (!ticket) return refusal("not_found", "No ticket with that id is available to this member.");
      const to = await deps.prisma.ticketStage.findFirst({
        where: { id: input.stageId, workspaceId: ctx.workspaceId },
        select: { id: true, label: true, pipelineId: true, isTerminal: true, isWon: true },
      });
      if (!to || to.pipelineId !== ticket.pipelineId) return refusal("invalid", "That stage is not in the ticket's pipeline.");
      if (to.id === ticket.stageId) return refusal("invalid", "The ticket is already in that stage.");
      const lost = to.isTerminal && !to.isWon;
      if (lost && !input.note && !input.lostReasonId) return refusal("invalid", "Moving to a lost stage needs a reason (note or lostReasonId).");
      const args: Record<string, unknown> = { ticketId: ticket.id, stageId: to.id, fromStageId: ticket.stageId };
      if (input.note) args.note = input.note;
      if (input.lostReasonId) args.lostReasonId = input.lostReasonId;
      return {
        args,
        permission: "tickets.update",
        risk: to.isTerminal ? "high" : "medium",
        card: {
          title: "move_ticket_stage",
          changes: [
            { label: "ticket", after: `#${ticket.number} · ${ticket.title}` },
            { label: "ticket.stage", before: ticket.stage?.label ?? "", after: to.label },
            ...(input.note ? [{ label: "ticket.note", after: input.note }] : []),
          ],
        },
      };
    },
    async recheck(exec: ExecContext, args): Promise<Recheck> {
      const ticketId = String(args.ticketId);
      if (!(await canOpen(deps, exec.workspaceId, exec.viewer, ticketId))) return "permission_revoked";
      const t = await deps.prisma.ticket.findFirst({ where: { id: ticketId, workspaceId: exec.workspaceId }, select: { stageId: true } });
      return t && t.stageId === args.fromStageId ? "ok" : "card_outdated";
    },
    async apply(exec: ExecContext, args) {
      const dto: MoveTicketDto = {
        stageId: String(args.stageId),
        ...(args.note ? { note: String(args.note), lostReason: String(args.note) } : {}),
        ...(args.lostReasonId ? { lostReasonId: String(args.lostReasonId) } : {}),
        byUserId: exec.viewer.userId,
      };
      try {
        const t = await deps.tickets.moveTicket(exec.workspaceId, String(args.ticketId), dto, exec.viewer, { expectStageId: String(args.fromStageId) });
        return { ticketId: (t as { id: string }).id, stageId: dto.stageId };
      } catch (e) {
        if (e instanceof ConflictException) throw new CardOutdated();
        throw e;
      }
    },
  };
}
