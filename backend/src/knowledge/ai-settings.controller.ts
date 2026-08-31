import { Body, Controller, Get, Patch, Post } from "@nestjs/common";
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { KEWY_AUTONOMY_MODES, type KewyAutonomyMode } from "./knowledge.client";
import { AiSettingsService } from "./ai-settings.service";

const Trim = Transform(({ value }) => (typeof value === "string" ? value.trim() : value));

/**
 * Neither DTO has a tenantId, and that is load-bearing: the global
 * ValidationPipe runs `forbidNonWhitelisted`, so a client that posts one gets a
 * 400 naming it rather than having it quietly stripped.
 */
class ToggleDto {
  @IsBoolean() enabled!: boolean;

  /** Required when disabling — enforced in the service, not here, because the
   *  rule is conditional on `enabled` and deserves a sentence the owner can
   *  act on rather than a field-level validation error. 500 is upstream's cap. */
  @IsOptional() @Trim @IsString() @MinLength(1) @MaxLength(500) reason?: string;
}

class PatchSettingsDto {
  /** The ONLY writable field in this pass. Anything else in the body is a 400
   *  from forbidNonWhitelisted — deliberately, since this proxy would otherwise
   *  become an undocumented path to the whole upstream config. */
  @IsIn(KEWY_AUTONOMY_MODES as unknown as string[]) autonomyMode!: KewyAutonomyMode;
}

/**
 * Owner-facing proxy to kewy-ai's tenant config and kill switch.
 *
 * Mounted at `ai/settings` (so `/api/ai/settings`) behind the CRM's normal
 * AuthGuard — pointedly NOT `@Public()`. Before this existed, silencing your
 * own bot meant phoning a developer to run an UPDATE.
 */
@Controller("ai/settings")
export class AiSettingsController {
  constructor(private readonly svc: AiSettingsService) {}

  @Get()
  get(@CurrentWorkspace() workspaceId: string) {
    return this.svc.get(workspaceId);
  }

  /** The emergency stop. Off = the agent is never invoked; inbound messages are
   *  still stored upstream so a human can answer them. */
  @Post("toggle")
  toggle(@CurrentWorkspace() workspaceId: string, @Body() dto: ToggleDto) {
    return this.svc.setEnabled(workspaceId, { enabled: dto.enabled, reason: dto.reason });
  }

  /** Delivery mode only — whether replies are sent or written as drafts. */
  @Patch()
  patch(@CurrentWorkspace() workspaceId: string, @Body() dto: PatchSettingsDto) {
    return this.svc.setAutonomyMode(workspaceId, dto.autonomyMode);
  }
}
