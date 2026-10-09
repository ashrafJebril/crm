import { Module } from "@nestjs/common";
import { JoteckController } from "./joteck.controller";
import { JoteckService } from "./joteck.service";
import { JoteckGuard } from "./joteck.guard";
import { AdminModule } from "../admin/admin.module";
import { IntegrationsModule } from "../integrations/integrations.module";

@Module({
  imports: [AdminModule, IntegrationsModule],
  controllers: [JoteckController],
  providers: [JoteckService, JoteckGuard],
})
export class JoteckModule {}
