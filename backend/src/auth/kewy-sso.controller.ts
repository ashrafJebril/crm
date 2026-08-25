import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Public } from "./public.decorator";
import { KewySsoService } from "./kewy-sso.service";
import { KewySsoExchangeDto } from "./dto";

/**
 * Kewy handoff exchange. @Public so the global user-JWT AuthGuard skips it —
 * the Kewy token IS the credential here, verified inside the service against
 * Kewy's public key.
 */
@Controller("auth/sso")
export class KewySsoController {
  constructor(private readonly svc: KewySsoService) {}

  @Public()
  @Post("kewy")
  @HttpCode(200)
  exchange(@Body() body: KewySsoExchangeDto) {
    return this.svc.exchange(body);
  }
}
