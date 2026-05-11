import { Module } from "@nestjs/common";
import { MentionsController } from "./mentions.controller";
import { MentionsService } from "./mentions.service";
import { KeywordsController } from "./keywords.controller";
import { KeywordsService } from "./keywords.service";
import { EnrichmentService } from "./enrichment.service";
import { MentionsScheduler, MentionsAdminController } from "./mentions.scheduler";
import { GoogleCsePoller } from "./sources/google-cse.poller";
import { MetaIgPoller } from "./sources/meta-ig.poller";
import { OpenTicketService } from "./open-ticket.service";

@Module({
  controllers: [MentionsController, KeywordsController, MentionsAdminController],
  providers: [
    MentionsService,
    KeywordsService,
    EnrichmentService,
    MentionsScheduler,
    GoogleCsePoller,
    MetaIgPoller,
    OpenTicketService,
  ],
})
export class MentionsModule {}
