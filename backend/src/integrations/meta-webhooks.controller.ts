import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import { MetaWebhooksService } from "./meta-webhooks.service";
import { Public } from "../auth/public.decorator";

@Controller("webhooks/meta")
export class MetaWebhooksController {
  constructor(private readonly svc: MetaWebhooksService) {}

  @Public()
  @Get()
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
  ) {
    return this.svc.verify(mode, token, challenge);
  }

  @Public()
  @Post()
  @HttpCode(200)
  receive(@Body() payload: unknown) {
    return this.svc.handle(payload as Parameters<MetaWebhooksService["handle"]>[0]);
  }
}
