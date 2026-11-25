import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";
import { WebhookOutboxListener } from "./webhook-outbox.listener";
import { WebhookDispatcher } from "./webhook-dispatcher";
import { WebhookRetentionScheduler } from "./webhook-retention.scheduler";

/**
 * SP-27 outgoing webhooks. Depends only on global modules (Prisma, audit,
 * permissions, billing's payment lock, notifications); the emit points send
 * through the global EventEmitter, so no feature module imports this one.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookOutboxListener, WebhookDispatcher, WebhookRetentionScheduler],
})
export class WebhooksModule {}
