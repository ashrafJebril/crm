import { Module } from "@nestjs/common";
import { JoteckController } from "./joteck.controller";
import { JoteckService } from "./joteck.service";
import { JoteckGuard } from "./joteck.guard";

@Module({
  controllers: [JoteckController],
  providers: [JoteckService, JoteckGuard],
})
export class JoteckModule {}
