import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { SocialController } from "./social.controller";
import { SocialService } from "./social.service";

@Module({
  imports: [IntegrationsModule],
  controllers: [SocialController],
  providers: [SocialService],
  exports: [SocialService],
})
export class SocialModule {}
