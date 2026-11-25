import { Module } from "@nestjs/common";
import { RecipientTrackerService } from "./recipient-tracker.service";
import { CampaignReplyAttributor } from "./reply-attributor.service";

/**
 * SP-12: provider-only module for per-recipient tracking. Its only
 * dependency is the global PrismaService, so IntegrationsModule (Zernio and
 * Meta webhooks), ChannelsCoreModule (InboundSinkService) and CampaignsModule
 * can all import it without a cycle (CampaignsModule already imports
 * IntegrationsModule).
 */
@Module({
  providers: [RecipientTrackerService, CampaignReplyAttributor],
  exports: [RecipientTrackerService, CampaignReplyAttributor],
})
export class CampaignTrackingModule {}
