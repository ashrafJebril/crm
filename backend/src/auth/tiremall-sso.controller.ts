import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Public } from "./public.decorator";
import { TiremallSsoService } from "./tiremall-sso.service";
import { TiremallSsoExchangeDto } from "./dto";

/**
 * Tiremall handoff exchange. @Public so the global user-JWT AuthGuard skips it —
 * the Tiremall token IS the credential, verified in the service against the
 * shared HS256 secret.
 */
@Controller("auth/sso")
export class TiremallSsoController {
  constructor(private readonly svc: TiremallSsoService) {}

  @Public()
  @Post("tiremall")
  @HttpCode(200)
  exchange(@Body() body: TiremallSsoExchangeDto) {
    return this.svc.exchange(body);
  }
}
