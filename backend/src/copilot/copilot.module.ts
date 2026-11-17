import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { RecordsModule } from "../records/records.module";
import { SearchModule } from "../search/search.module";
import { TicketsModule } from "../tickets/tickets.module";
import { BookingsModule } from "../bookings/bookings.module";
import { KnowledgeSourcesModule } from "../knowledge-sources/knowledge-sources.module";
import { InsightsModule } from "../insights/insights.module";
import { ActivitiesModule } from "../activities/activities.module";
import { MediaModule } from "../media/media.module";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import { RecordsService } from "../records/records.service";
import { SearchService } from "../search/search.service";
import { TicketsService } from "../tickets/tickets.service";
import { BookingsService } from "../bookings/bookings.service";
import { KnowledgeSearchService } from "../knowledge-sources/knowledge-search.service";
import { KnowledgeSourcesService } from "../knowledge-sources/knowledge-sources.service";
import { InsightsService } from "../insights/insights.service";
import { ActivitiesService } from "../activities/activities.service";
import { CopilotController } from "./copilot.controller";
import { CopilotRefsService } from "./copilot-refs.service";
import { CopilotSessionsService } from "./copilot-sessions.service";
import { CopilotTurnService } from "./copilot-turn.service";
import { COPILOT_REGISTRY } from "./copilot-registry.token";
import { CopilotActionsService } from "./copilot-actions.service";
import { CopilotAttachmentsService } from "./copilot-attachments.service";
import { CopilotAttachmentsSweep } from "./copilot-attachments.sweep";
import { buildRegistry } from "./copilot-tools/read-tools";

/**
 * SP-18 the in-app copilot ("Ask Kewy"): streaming turns, per-member
 * history, permission-checked references, read tools and sources (Task 1);
 * confirmation cards, approval modes, write tools and attachments (Task 2).
 * The tool registry is built here from the existing services, so every tool
 * runs through the same code (and the same permission checks) as the UI.
 */
@Module({
  imports: [AiModule, RecordsModule, SearchModule, TicketsModule, BookingsModule, KnowledgeSourcesModule, InsightsModule, ActivitiesModule, MediaModule],
  controllers: [CopilotController],
  providers: [
    CopilotTurnService,
    CopilotSessionsService,
    CopilotRefsService,
    CopilotActionsService,
    CopilotAttachmentsService,
    CopilotAttachmentsSweep,
    {
      provide: COPILOT_REGISTRY,
      useFactory: (
        prisma: PrismaService,
        perm: PermissionService,
        records: RecordsService,
        search: SearchService,
        tickets: TicketsService,
        bookings: BookingsService,
        activities: ActivitiesService,
        attachments: CopilotAttachmentsService,
        knowledge?: KnowledgeSearchService,
        insights?: InsightsService,
        knowledgeSources?: KnowledgeSourcesService,
      ) =>
        buildRegistry(
          { prisma, perm, records, search, tickets, bookings, knowledge, insights },
          { prisma, records, activities, tickets, knowledgeSources, attachments },
        ),
      inject: [
        PrismaService,
        PermissionService,
        RecordsService,
        SearchService,
        TicketsService,
        BookingsService,
        ActivitiesService,
        CopilotAttachmentsService,
        { token: KnowledgeSearchService, optional: true },
        { token: InsightsService, optional: true },
        { token: KnowledgeSourcesService, optional: true },
      ],
    },
  ],
  exports: [CopilotTurnService, CopilotSessionsService, CopilotActionsService, COPILOT_REGISTRY],
})
export class CopilotModule {}
