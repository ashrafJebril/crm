import { Injectable, OnModuleInit } from "@nestjs/common";
import { ZernioService } from "../integrations/zernio.service";
import { channelError } from "./channel-errors";
import { ChannelTransportRegistry } from "./channel-transport";

/**
 * SP-19 T5 fix round 1 (I1): the `zernio` ChannelTransport. Zernio keeps its
 * dedicated send routes, so `sendText` answers transport_unavailable exactly
 * as an unregistered provider did. Its only job is the `reconnect` hook
 * behind `POST /channels/:id/reconnect` (ZernioService.reconnectChannel).
 * No `disconnect` hook: a hub disconnect leaves the account at Zernio.
 */
@Injectable()
export class ZernioChannelTransport implements OnModuleInit {
  constructor(
    private readonly zernio: ZernioService,
    private readonly transports: ChannelTransportRegistry,
  ) {}

  onModuleInit(): void {
    if (this.transports.get("zernio")) return;
    this.transports.register({
      provider: "zernio",
      sendText: async () => {
        throw channelError("channels.transport_unavailable", { provider: "zernio" });
      },
      reconnect: (channel) => this.zernio.reconnectChannel(channel),
    });
  }
}
