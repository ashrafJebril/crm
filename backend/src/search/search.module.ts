import { Module } from "@nestjs/common";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";

@Module({
  controllers: [SearchController],
  providers: [SearchService],
  // SP-18: the copilot's search_contacts runs the same gated search as the member.
  exports: [SearchService],
})
export class SearchModule {}
