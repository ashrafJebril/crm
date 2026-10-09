import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TicketsService } from "./tickets.service";

/**
 * Lifecycle automation between the Inbox and the Pipeline (2026-08-19):
 *
 *  - inbound message  → ticket in the 'new'-group stage, unless the contact
 *    already has an OPEN ticket in that pipeline (won/lost don't block, so a
 *    returning customer re-enters at New);
 *  - outbound human reply → the contact's ticket moves new → contacted,
 *    strictly one-way (a ticket already past New never moves).
 *
 * Stages resolve by groupKey ('new' / 'contacted') in the first pipeline that
 * has both, so renaming stages in the UI can't break the automation; a
 * workspace whose pipeline lacks those groups gets a warn log and a no-op.
 *
 * Every entry point swallows its own failures: pipeline automation must never
 * break message ingestion.
 */
@Injectable()
export class PipelineAutomationService {
  private readonly log = new Logger(PipelineAutomationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
  ) {}

  private async resolveStages(workspaceId: string) {
    const stages = await this.prisma.ticketStage.findMany({
      where: { workspaceId, groupKey: { in: ["new", "contacted"] } },
      orderBy: { order: "asc" },
    });
    const byPipeline = new Map<
      string,
      { newStage?: (typeof stages)[number]; contacted?: (typeof stages)[number] }
    >();
    for (const s of stages) {
      const entry = byPipeline.get(s.pipelineId) ?? {};
      if (s.groupKey === "new" && !entry.newStage) entry.newStage = s;
      if (s.groupKey === "contacted" && !entry.contacted) entry.contacted = s;
      byPipeline.set(s.pipelineId, entry);
    }
    for (const [pipelineId, entry] of byPipeline) {
      if (entry.newStage && entry.contacted) {
        return { pipelineId, newStage: entry.newStage, contacted: entry.contacted };
      }
    }
    return null;
  }

  /**
   * Advance a ticket to the stage the AI inferred from the conversation.
   *
   * FOUR RULES, all deliberate:
   *
   * 1. FORWARD ONLY. The agent may advance a ticket, never drag it back. A
   *    confused customer message must not be able to undo a real sale, and a
   *    board that reorders itself behind staff is worse than no automation.
   *
   * 2. CONFIDENCE FLOOR. Below the threshold the suggestion is logged and
   *    dropped. A few bad auto-moves destroy trust in the board faster than
   *    having no automation at all.
   *
   * 3. NEVER auto-close. isTerminal / isWon stages stay human-only: won and
   *    lost are money outcomes and need a person.
   *
   * 4. Resolved by groupKey, never by label — matching the rest of this
   *    service, so renaming a stage in the UI cannot break automation.
   */
  async onAiStageSuggestion(
    workspaceId: string,
    contactId: string,
    groupKey: string,
    confidence: number,
    reason?: string,
  ): Promise<void> {
    const MIN_CONFIDENCE = 0.7;
    try {
      if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
        this.log.log(
          `ai stage '${groupKey}' for contact=${contactId} ignored: confidence ${confidence} < ${MIN_CONFIDENCE}`,
        );
        return;
      }

      const ticket = await this.prisma.ticket.findFirst({
        where: { workspaceId, contactId, stage: { isTerminal: false } },
        include: { stage: true },
        orderBy: { createdAt: "desc" },
      });
      if (!ticket) return;

      const target = await this.prisma.ticketStage.findFirst({
        where: { workspaceId, pipelineId: ticket.pipelineId, groupKey },
        orderBy: { order: "asc" },
      });
      if (!target) {
        this.log.warn(
          `ai suggested stage group '${groupKey}' but pipeline=${ticket.pipelineId} has no such stage`,
        );
        return;
      }

      if (target.isTerminal || target.isWon) {
        this.log.log(`ai stage '${groupKey}' ignored: won/lost stays a human decision`);
        return;
      }
      if (target.order <= ticket.stage.order) {
        this.log.log(
          `ai stage '${groupKey}' ignored: would move ticket=${ticket.id} backwards or sideways`,
        );
        return;
      }

      await this.prisma.$transaction([
        this.prisma.ticket.update({
          where: { id: ticket.id },
          data: { stageId: target.id },
        }),
        // byUserId stays null — the board history must show this was not a
        // person, and the reason makes the move auditable after the fact.
        this.prisma.ticketActivity.create({
          data: {
            workspaceId,
            ticketId: ticket.id,
            kind: "stage_changed",
            fromStage: ticket.stage.key,
            toStage: target.key,
            note: `moved by AI (${Math.round(confidence * 100)}%)${reason ? `: ${reason}` : ""}`,
          },
        }),
      ]);
    } catch (e) {
      // Same discipline as the rest of this service: pipeline automation must
      // never break the message path that triggered it.
      this.log.warn(`ai stage move for contact=${contactId} failed: ${(e as Error).message}`);
    }
  }

  /** Inbound customer message: open a ticket in 'new' if none is open. */
  async onInboundMessage(
    workspaceId: string,
    contactId: string,
    conversationId: string,
    channel: string,
    preview?: string,
  ): Promise<void> {
    try {
      const target = await this.resolveStages(workspaceId);
      if (!target) {
        this.log.warn(
          `ws=${workspaceId} has no pipeline with new+contacted stage groups — skipping auto-ticket for ${channel} message`,
        );
        return;
      }
      const open = await this.prisma.ticket.findFirst({
        where: {
          workspaceId,
          contactId,
          pipelineId: target.pipelineId,
          stage: { isTerminal: false },
        },
        select: { id: true },
      });
      if (open) return;
      const contact = await this.prisma.contact.findFirst({
        where: { id: contactId, workspaceId },
        select: { name: true },
      });
      await this.tickets.createTicket(workspaceId, {
        pipelineId: target.pipelineId,
        stageId: target.newStage.id,
        contactId,
        conversationId,
        title: contact?.name ?? "New lead",
        description: preview ? preview.slice(0, 300) : undefined,
      });
    } catch (e) {
      this.log.warn(
        `auto-ticket for contact=${contactId} failed: ${(e as Error).message}`,
      );
    }
  }

  /** Outbound human reply: move the contact's 'new' ticket to 'contacted'. */
  async onOutboundReply(workspaceId: string, contactId: string): Promise<void> {
    try {
      const target = await this.resolveStages(workspaceId);
      if (!target) return;
      const ticket = await this.prisma.ticket.findFirst({
        where: {
          workspaceId,
          contactId,
          pipelineId: target.pipelineId,
          stageId: target.newStage.id,
        },
        select: { id: true },
      });
      if (!ticket) return; // nothing in 'new' — never move backward or skip
      await this.tickets.moveTicket(workspaceId, ticket.id, {
        stageId: target.contacted.id,
      });
    } catch (e) {
      this.log.warn(
        `auto-move to contacted for contact=${contactId} failed: ${(e as Error).message}`,
      );
    }
  }
}
