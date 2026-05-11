import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class OpenTicketService {
  constructor(private readonly prisma: PrismaService) {}

  async fromMention(mentionId: string) {
    const mention = await this.prisma.mention.findUnique({ where: { id: mentionId } });
    if (!mention) throw new NotFoundException("Mention not found");
    if (mention.status === "triaged" || mention.status === "engaged") {
      throw new ConflictException("Ticket already opened for this mention");
    }

    const pipeline = await this.prisma.pipeline.findFirst({
      where: { isDefault: true },
      include: { stages: { orderBy: { order: "asc" } } },
    });
    if (!pipeline || pipeline.stages.length === 0) {
      throw new NotFoundException("No default pipeline configured");
    }
    const firstStage = pipeline.stages[0];

    return this.prisma.$transaction(async (tx) => {
      const contact = await tx.contact.create({
        data: {
          name: mention.author,
          phone: null,
          industry: "social",
          lifecycle: "lead",
          source: mention.source,
          lastSeen: "just now",
          tags: JSON.stringify(["mention", mention.source]),
        },
      });

      const lastTicket = await tx.ticket.findFirst({
        where: { pipelineId: pipeline.id },
        orderBy: { number: "desc" },
      });
      const number = (lastTicket?.number ?? 0) + 1;

      const ticket = await tx.ticket.create({
        data: {
          number,
          pipelineId: pipeline.id,
          stageId: firstStage.id,
          contactId: contact.id,
          title: mention.body.slice(0, 80),
          description: mention.sourceUrl ?? null,
        },
      });

      await tx.mention.update({
        where: { id: mentionId },
        data: { status: "triaged" },
      });

      return { ticketId: ticket.id, contactId: contact.id };
    });
  }
}
