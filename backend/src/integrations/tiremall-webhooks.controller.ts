import { Body, Controller, Headers, HttpCode, Post } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { TiremallCustomersWebhookDto } from "./tiremall-webhooks.dto";
import { TiremallWebhooksService } from "./tiremall-webhooks.service";

/** Inbound customer webhook from Tiremall; trust via `x-tiremall-secret`. */
@Controller("webhooks/tiremall")
export class TiremallWebhooksController {
  constructor(private readonly svc: TiremallWebhooksService) {}

  @Public()
  @Post("customers")
  @HttpCode(200)
  customers(
    @Headers("x-tiremall-secret") secret: string | undefined,
    @Body() body: TiremallCustomersWebhookDto,
  ) {
    this.svc.verifySecret(secret);
    return this.svc.handle(body);
  }
}
