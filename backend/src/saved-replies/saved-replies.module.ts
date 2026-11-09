import { Module } from "@nestjs/common";
import { SavedRepliesController } from "./saved-replies.controller";
import { SavedRepliesService } from "./saved-replies.service";

@Module({ controllers: [SavedRepliesController], providers: [SavedRepliesService] })
export class SavedRepliesModule {}
