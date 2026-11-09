import "reflect-metadata";
import { GLOBAL_MODULE_METADATA, MODULE_METADATA } from "@nestjs/common/constants";
import { ChannelsModule } from "./channels.module";
import { ChannelsCoreModule } from "./channels-core.module";
import { ChannelsController } from "./channels.controller";
import { TelegramController } from "./telegram/telegram.controller";
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

describe("channels modules", () => {
  it("the global core exports the routing building blocks", () => {
    expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, ChannelsCoreModule)).toBe(true);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, ChannelsCoreModule)).toEqual(
      expect.arrayContaining([ChannelResolver, ChannelTransportRegistry, InboundSinkService]),
    );
  });

  it("the feature module serves the hub, Telegram and web chat controllers", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ChannelsModule)).toEqual([ChannelsController, TelegramController, WebchatController]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChannelsModule)).toEqual(
      expect.arrayContaining([TelegramService, TelegramClient, TelegramWebhookGuard, WebchatService, WidgetGateway, WidgetOriginGuard, WidgetRateLimitGuard]),
    );
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChannelsModule) as unknown[];
    expect(providers).toContainEqual(expect.objectContaining({ provide: WidgetRateLimiter }));
  });
});
