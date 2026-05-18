import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { KnowledgeController } from "./knowledge.controller";
import { KnowledgeService } from "./knowledge.service";
import { KnowledgeSearchService } from "./knowledge-search.service";

@Module({
  imports: [PrismaModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeSearchService],
  exports: [KnowledgeService, KnowledgeSearchService],
})
export class KnowledgeModule {}
