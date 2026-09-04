import { Body, Controller, Headers, HttpCode, Post } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { LMessageWebhookDto } from "./l-webhooks.dto";
import { LWebhooksService } from "./l-webhooks.service";

/**
 * Inbound webhook from l (agent platform). Public route — trust is established
 * by the shared `x-l-secret` header, which the service verifies before any work
 * happens.
 */
@Controller("webhooks/l")
export class LWebhooksController {
  constructor(private readonly svc: LWebhooksService) {}

  @Public()
  @Post("messages")
  @HttpCode(200)
  messages(
    @Headers("x-l-secret") secret: string | undefined,
    @Body() body: LMessageWebhookDto,
  ) {
    this.svc.verifySecret(secret);
    return this.svc.handle(body);
  }
}
