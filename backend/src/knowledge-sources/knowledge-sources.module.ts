import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { KnowledgeSearchService } from "./knowledge-search.service";
import { KnowledgeSourcesController } from "./knowledge-sources.controller";
import { KnowledgeSourcesService } from "./knowledge-sources.service";
import { KnowledgeUploadInterceptor } from "./knowledge-upload.interceptor";
import { LKnowledge } from "./l-knowledge";
import { WebsiteController } from "./website/website.controller";
import { WebsitesService } from "./website/websites.service";

/**
 * The business's knowledge screens and search. Everything is stored,
 * processed, crawled and searched on l; this module forwards to its joteck
 * knowledge API (l-knowledge.ts) and keeps crm's routes and shapes.
 */
@Module({
  imports: [IntegrationsModule],
  controllers: [KnowledgeSourcesController, WebsiteController],
  providers: [LKnowledge, KnowledgeSourcesService, KnowledgeSearchService, KnowledgeUploadInterceptor, WebsitesService],
  exports: [LKnowledge, KnowledgeSourcesService, KnowledgeSearchService, WebsitesService],
})
export class KnowledgeSourcesModule {}
