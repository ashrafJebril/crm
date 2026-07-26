import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JoteckGuard } from "./joteck.guard";
import { Public } from "../auth/public.decorator";
import { JoteckService } from "./joteck.service";
import { ProvisionClientDto } from "../admin/admin.dto";

interface JoteckWorkspacePatch {
  active?: boolean;
  enabledModules?: string[];
}

/**
 * JOTECK admin service-to-service surface. Uses a shared HMAC secret in the
 * `x-joteck-secret` header (see JoteckGuard). Marked @Public so the global
 * user-JWT AuthGuard skips it.
 */
@Public()
@UseGuards(JoteckGuard)
@Controller("joteck")
export class JoteckController {
  constructor(private readonly svc: JoteckService) {}

  @Get("workspaces")
  list(@Query("q") q?: string) {
    return this.svc.listWorkspaces(q);
  }

  @Post("workspaces")
  provision(@Body() dto: ProvisionClientDto) {
    return this.svc.provisionWorkspace(dto);
  }

  @Get("workspaces/:id")
  get(@Param("id") id: string) {
    return this.svc.getWorkspace(id);
  }

  @Get("workspaces/:id/stats")
  stats(@Param("id") id: string) {
    return this.svc.stats(id);
  }

  @Patch("workspaces/:id")
  patch(@Param("id") id: string, @Body() body: JoteckWorkspacePatch) {
    return this.svc.patchWorkspace(id, body);
  }
}
