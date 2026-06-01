import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { AiReplyService } from "./ai-reply.service";

@Module({
  imports: [PrismaModule, KnowledgeModule],
  providers: [AiReplyService],
  exports: [AiReplyService],
})
export class AiModule {}
