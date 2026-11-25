/**
 * SP-18: what the write tools need. Every write goes through the existing
 * service (ActivitiesService, TicketsService, KnowledgeSourcesService) as the
 * member, so the service's own checks apply on top of the copilot's.
 */
import type { PrismaService } from "../../prisma/prisma.service";
import type { RecordsService } from "../../records/records.service";
import type { ActivitiesService } from "../../activities/activities.service";
import type { TicketsService } from "../../tickets/tickets.service";
import type { KnowledgeSourcesService } from "../../knowledge-sources/knowledge-sources.service";
import type { CopilotAttachmentsService } from "../copilot-attachments.service";

export interface WriteToolDeps {
  prisma: PrismaService;
  records: RecordsService;
  activities: Pick<ActivitiesService, "create">;
  tickets: Pick<TicketsService, "moveTicket">;
  knowledgeSources?: Pick<KnowledgeSourcesService, "uploadFiles">;
  attachments: Pick<CopilotAttachmentsService, "own" | "readBytes">;
}

export const refusal = (error: string, note: string) => ({ error, note });
