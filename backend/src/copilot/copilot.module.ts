import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { RecordsModule } from "../records/records.module";
import { SearchModule } from "../search/search.module";
import { TicketsModule } from "../tickets/tickets.module";
import { BookingsModule } from "../bookings/bookings.module";
import { KnowledgeSourcesModule } from "../knowledge-sources/knowledge-sources.module";
import { InsightsModule } from "../insights/insights.module";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import { RecordsService } from "../records/records.service";
import { SearchService } from "../search/search.service";
import { TicketsService } from "../tickets/tickets.service";
import { BookingsService } from "../bookings/bookings.service";
import { KnowledgeSearchService } from "../knowledge-sources/knowledge-search.service";
import { InsightsService } from "../insights/insights.service";
import { CopilotController } from "./copilot.controller";
import { CopilotRefsService } from "./copilot-refs.service";
import { CopilotSessionsService } from "./copilot-sessions.service";
import { COPILOT_REGISTRY, CopilotTurnService } from "./copilot-turn.service";
import { buildReadRegistry } from "./copilot-tools/read-tools";

/**
 * SP-18 the in-app copilot ("Ask Kewy"): streaming turns, per-member
 * history, permission-checked references, the read tools and sources. The
 * tool registry is built here from the existing services, so every tool runs
 * through the same code (and the same permission checks) as the UI. Task 2
 * adds pending actions, write tools and attachments.
 */
@Module({
  imports: [AiModule, RecordsModule, SearchModule, TicketsModule, BookingsModule, KnowledgeSourcesModule, InsightsModule],
  controllers: [CopilotController],
  providers: [
    CopilotTurnService,
    CopilotSessionsService,
    CopilotRefsService,
    {
      provide: COPILOT_REGISTRY,
      useFactory: (
        prisma: PrismaService,
        perm: PermissionService,
        records: RecordsService,
        search: SearchService,
        tickets: TicketsService,
        bookings: BookingsService,
        knowledge?: KnowledgeSearchService,
        insights?: InsightsService,
      ) => buildReadRegistry({ prisma, perm, records, search, tickets, bookings, knowledge, insights }),
      inject: [
        PrismaService,
        PermissionService,
        RecordsService,
        SearchService,
        TicketsService,
        BookingsService,
        { token: KnowledgeSearchService, optional: true },
        { token: InsightsService, optional: true },
      ],
    },
  ],
  exports: [CopilotTurnService, CopilotSessionsService, COPILOT_REGISTRY],
})
export class CopilotModule {}

