import { Module } from "@nestjs/common";
import { RecordsController } from "./records.controller";
import { RecordsService } from "./records.service";

@Module({
  controllers: [RecordsController],
  providers: [RecordsService],
  // SP-18: copilot references, page context and record tools read as the member.
  exports: [RecordsService],
})
export class RecordsModule {}
