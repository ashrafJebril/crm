import { Module } from "@nestjs/common";
import { FacebookController } from "./facebook.controller";
import { FacebookService } from "./facebook.service";
import { InstagramController } from "./instagram.controller";
import { InstagramService } from "./instagram.service";
import { MediaModule } from "../media/media.module";

@Module({
  imports: [MediaModule],
  controllers: [FacebookController, InstagramController],
  providers: [FacebookService, InstagramService],
  exports: [FacebookService, InstagramService],
})
export class IntegrationsModule {}
