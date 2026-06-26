import { Body, Controller, Headers, HttpCode, Post } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { HjzClientWebhookDto } from "./hjz-webhooks.dto";
import { HjzWebhooksService } from "./hjz-webhooks.service";

/**
 * Inbound webhook from hjz-v2. Public route — trust is established by the
 * shared `x-marketing-secret` header, which the service verifies before any
 * work happens.
 */
@Controller("webhooks/hjz")
export class HjzWebhooksController {
  constructor(private readonly svc: HjzWebhooksService) {}

  @Public()
  @Post("clients")
  @HttpCode(200)
  clients(
    @Headers("x-marketing-secret") secret: string | undefined,
    @Body() body: HjzClientWebhookDto,
  ) {
    this.svc.verifySecret(secret);
    return this.svc.handle(body);
  }
}
