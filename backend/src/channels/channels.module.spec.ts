import "reflect-metadata";
import { GLOBAL_MODULE_METADATA, MODULE_METADATA } from "@nestjs/common/constants";
import { ChannelsModule } from "./channels.module";
import { ChannelsCoreModule } from "./channels-core.module";
import { ChannelsController } from "./channels.controller";
import { TelegramController } from "./telegram/telegram.controller";
import { WhatsappChannelsController } from "./whatsapp/whatsapp-channels.controller";
import { TelegramService } from "./telegram/telegram.service";
import { TelegramClient } from "./telegram/telegram.client";
import { TelegramWebhookGuard } from "./telegram/telegram-webhook.guard";
import { ChannelResolver } from "./channel-resolver.service";
import { ChannelTransportRegistry } from "./channel-transport";
import { InboundSinkService } from "./inbound-sink.service";
import { WebchatController } from "./webchat/webchat.controller";
import { WebchatService } from "./webchat/webchat.service";
import { WidgetGateway } from "./webchat/widget.gateway";
import { WidgetOriginGuard } from "./webchat/widget-origin.guard";
import { WidgetRateLimiter, WidgetRateLimitGuard } from "./webchat/widget-rate-limit.guard";
import { ZernioChannelTransport } from "./zernio-transport";
import { ChannelHealthController } from "./health/channel-health.controller";
import { ChannelHealthService } from "./health/channel-health.service";
import { ChannelHealthScheduler } from "./health/channel-health.scheduler";
import { HealthNotifier } from "./health/health-notifier";
import { HealthCheckTrigger } from "./health/health-check-trigger";
import { NotificationsModule } from "../notifications/notifications.module";
import { TemplatesModule } from "../templates/templates.module";

describe("channels modules", () => {
  it("the global core exports the routing building blocks", () => {
    expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, ChannelsCoreModule)).toBe(true);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, ChannelsCoreModule)).toEqual(
      expect.arrayContaining([ChannelResolver, ChannelTransportRegistry, InboundSinkService, HealthCheckTrigger]),
    );
  });

  it("the feature module serves the hub, Telegram and web chat controllers", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ChannelsModule)).toEqual([
      ChannelsController,
      TelegramController,
      WebchatController,
      WhatsappChannelsController,
      ChannelHealthController,
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChannelsModule)).toEqual(
      expect.arrayContaining([
        TelegramService,
        TelegramClient,
        TelegramWebhookGuard,
        WebchatService,
        WidgetGateway,
        WidgetOriginGuard,
        WidgetRateLimitGuard,
        ZernioChannelTransport,
        ChannelHealthService,
        // SP-14 Task 2: the hourly sweep and the downgrade notifier.
        ChannelHealthScheduler,
        HealthNotifier,
      ]),
    );
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, ChannelsModule)).toEqual(expect.arrayContaining([NotificationsModule, TemplatesModule]));
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChannelsModule) as unknown[];
    expect(providers).toContainEqual(expect.objectContaining({ provide: WidgetRateLimiter }));
  });
});
