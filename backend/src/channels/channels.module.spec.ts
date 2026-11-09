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

describe("channels modules", () => {
  it("the global core exports the routing building blocks", () => {
    expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, ChannelsCoreModule)).toBe(true);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, ChannelsCoreModule)).toEqual(
      expect.arrayContaining([ChannelResolver, ChannelTransportRegistry, InboundSinkService]),
    );
  });

  it("the feature module serves the hub and Telegram controllers", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ChannelsModule)).toEqual([ChannelsController, TelegramController]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChannelsModule)).toEqual(
      expect.arrayContaining([TelegramService, TelegramClient, TelegramWebhookGuard]),
    );
  });
});
