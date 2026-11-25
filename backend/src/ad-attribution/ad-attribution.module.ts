import { Module } from "@nestjs/common";
import { MediaModule } from "../media/media.module";
import { AdReferralService } from "./ad-referral.service";
import { AdSourcesController } from "./ad-sources.controller";
import { AdSourcesService } from "./ad-sources.service";
import { AdsMetricsService } from "./ads-metrics.service";

/**
 * SP-15 click-to-WhatsApp attribution: referral capture (used by the Zernio
 * and Meta-direct inbound paths in IntegrationsModule) and the ad-source
 * routes. PrismaService and PermissionService come from global modules.
 */
@Module({
  imports: [MediaModule],
  controllers: [AdSourcesController],
  providers: [AdReferralService, AdSourcesService, AdsMetricsService],
  exports: [AdReferralService, AdSourcesService],
})
export class AdAttributionModule {}
