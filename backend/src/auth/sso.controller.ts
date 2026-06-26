import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Public } from "./public.decorator";
import { SsoExchangeDto } from "./dto";
import { SsoService } from "./sso.service";

/**
 * SSO bridge from hjz-v2 → tkana. The caller does not yet hold a tkana token,
 * so the endpoint is @Public — trust is established by verifying the hjz token
 * signature inside SsoService (shared HJZ_JWT_ACCESS_SECRET). Only enabled
 * when AUTH_MODE=sso; standalone tkana returns 403 here.
 */
@Controller("auth/sso")
export class SsoController {
  constructor(private readonly sso: SsoService) {}

  @Public()
  @Post("exchange")
  @HttpCode(200)
  exchange(@Body() body: SsoExchangeDto) {
    return this.sso.exchange(body);
  }
}
