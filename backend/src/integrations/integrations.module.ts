import { Module } from "@nestjs/common";
import { FacebookController } from "./facebook.controller";
import { FacebookService } from "./facebook.service";
import { InstagramController } from "./instagram.controller";
import { InstagramService } from "./instagram.service";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppService } from "./whatsapp.service";
import { MediaModule } from "../media/media.module";

@Module({
  imports: [MediaModule],
  controllers: [FacebookController, InstagramController, WhatsAppController],
  providers: [FacebookService, InstagramService, WhatsAppService],
  exports: [FacebookService, InstagramService, WhatsAppService],
})
export class IntegrationsModule {}
