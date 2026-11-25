import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { MetaAdsController } from "./meta-ads.controller";
import { MetaAdsGraphClient } from "./meta-ads-graph.client";
import { MetaAdsNotifier } from "./meta-ads-notifier";
import { MetaAdsService } from "./meta-ads.service";
import { MetaAdsSyncScheduler } from "./meta-ads-sync.scheduler";

/**
 * SP-15 Meta Ads connect, the hourly spend sync and the reconnect alert.
 * PrismaService, PermissionService and JwtService come from global modules.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [MetaAdsController],
  providers: [MetaAdsGraphClient, MetaAdsNotifier, MetaAdsService, MetaAdsSyncScheduler],
  exports: [MetaAdsService, MetaAdsSyncScheduler],
})
export class MetaAdsModule {}
