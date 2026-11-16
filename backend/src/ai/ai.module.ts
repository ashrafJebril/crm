import { Module } from "@nestjs/common";
import { ClaudeService } from "./claude.service";

/** SP-21: the shared Claude client (SP-20 and SP-18 import this module). */
@Module({
  providers: [ClaudeService],
  exports: [ClaudeService],
})
export class AiModule {}
