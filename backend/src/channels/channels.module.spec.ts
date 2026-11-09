import "reflect-metadata";
import { GLOBAL_MODULE_METADATA, MODULE_METADATA } from "@nestjs/common/constants";
import { ChannelsModule } from "./channels.module";
import { ChannelsCoreModule } from "./channels-core.module";
import { ChannelsController } from "./channels.controller";
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

  it("the feature module serves the controller", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ChannelsModule)).toEqual([ChannelsController]);
  });
});
