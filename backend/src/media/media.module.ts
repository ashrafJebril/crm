import { Module } from "@nestjs/common";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";
import { MediaStorageProvider } from "./storage/storage.provider";

@Module({
  controllers: [MediaController],
  providers: [MediaService, MediaStorageProvider],
  exports: [MediaService],
})
export class MediaModule {}
