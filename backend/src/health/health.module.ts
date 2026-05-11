import { Controller, Get, Module } from "@nestjs/common";
import { Public } from "../auth/public.decorator";

@Controller("health")
class HealthController {
  @Public()
  @Get()
  health() {
    return { ok: true, ts: new Date().toISOString() };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
