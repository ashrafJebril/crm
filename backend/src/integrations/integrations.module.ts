import { Module } from "@nestjs/common";
import { FacebookController } from "./facebook.controller";
import { FacebookService } from "./facebook.service";
import { MediaModule } from "../media/media.module";

@Module({
  imports: [MediaModule],
  controllers: [FacebookController],
  providers: [FacebookService],
  exports: [FacebookService],
})
export class IntegrationsModule {}
