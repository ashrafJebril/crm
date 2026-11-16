import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { MediaModule } from "../media/media.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { KnowledgeProcessor, KNOWLEDGE_PUBLISH_HOOK, KNOWLEDGE_VISION } from "./knowledge-processor";
import { KnowledgePublisher } from "./knowledge-publisher";
import { KnowledgeSearchService } from "./knowledge-search.service";
import { KnowledgeSourcesController } from "./knowledge-sources.controller";
import { KnowledgeSourcesService } from "./knowledge-sources.service";
import { KnowledgeVision } from "./knowledge-vision";
import { KnowledgeUploadInterceptor } from "./knowledge-upload.interceptor";
import { CrawlRunner } from "./website/crawl-runner";
import { CrawlScheduler } from "./website/crawl.scheduler";
import { WebsiteController } from "./website/website.controller";
import { WebsitesService } from "./website/websites.service";

/**
 * SP-21: the knowledge store (sources, chunks, processing, preview, search),
 * websites (crawler and scheduler) and publishing (l prompt block, kewy-ai
 * copies). The existing `knowledge/` module (kewy-ai proxy, HJZ sync switch,
 * kill switch) is untouched apart from exporting its client. Exports search
 * for the MCP `search_knowledge` tool and SP-18/SP-20.
 */
@Module({
  imports: [AiModule, MediaModule, IntegrationsModule, KnowledgeModule, NotificationsModule],
  controllers: [KnowledgeSourcesController, WebsiteController],
  providers: [
    KnowledgeSourcesService,
    KnowledgeSearchService,
    KnowledgeProcessor,
    KnowledgeVision,
    KnowledgeUploadInterceptor,
    KnowledgePublisher,
    CrawlRunner,
    CrawlScheduler,
    WebsitesService,
    { provide: KNOWLEDGE_VISION, useExisting: KnowledgeVision },
    { provide: KNOWLEDGE_PUBLISH_HOOK, useExisting: KnowledgePublisher },
  ],
  exports: [KnowledgeSourcesService, KnowledgeSearchService, KnowledgeProcessor, KnowledgePublisher, WebsitesService],
})
export class KnowledgeSourcesModule {}
