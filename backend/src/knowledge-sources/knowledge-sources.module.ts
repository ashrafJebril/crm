import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { MediaModule } from "../media/media.module";
import { KnowledgeProcessor, KNOWLEDGE_VISION } from "./knowledge-processor";
import { KnowledgeSearchService } from "./knowledge-search.service";
import { KnowledgeSourcesController } from "./knowledge-sources.controller";
import { KnowledgeSourcesService } from "./knowledge-sources.service";
import { KnowledgeVision } from "./knowledge-vision";
import { KnowledgeUploadInterceptor } from "./knowledge-upload.interceptor";

/**
 * SP-21: the knowledge store (sources, chunks, processing, preview, search).
 * The existing `knowledge/` module (kewy-ai proxy, HJZ sync switch, kill
 * switch) is untouched. Exports search and the processor for Task 2 (MCP
 * `search_knowledge`, crawler) and SP-18/SP-20.
 */
@Module({
  imports: [AiModule, MediaModule],
  controllers: [KnowledgeSourcesController],
  providers: [
    KnowledgeSourcesService,
    KnowledgeSearchService,
    KnowledgeProcessor,
    KnowledgeVision,
    KnowledgeUploadInterceptor,
    { provide: KNOWLEDGE_VISION, useExisting: KnowledgeVision },
  ],
  exports: [KnowledgeSourcesService, KnowledgeSearchService, KnowledgeProcessor],
})
export class KnowledgeSourcesModule {}
