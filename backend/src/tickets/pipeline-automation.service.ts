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
