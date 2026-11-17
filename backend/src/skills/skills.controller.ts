import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { IsBoolean, IsInt, IsObject, IsOptional, Min } from "class-validator";
import type { JwtPayload } from "../auth/auth.guard";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { SkillsService } from "./skills.service";

export class InstallSkillDto {
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class PatchSkillDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  /** The ledger row's version (SkillDto.rowVersion). */
  @IsInt()
  @Min(0)
  version!: number;
}

export class UpdateSkillDto {
  @IsInt()
  @Min(0)
  version!: number;
}

/** SP-22 skills gallery routes (permissions in permission-map.ts). */
@Controller("skills")
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  list(@CurrentWorkspace() ws: string) {
    return this.skills.list(ws);
  }

  @Post(":key/install")
  install(@CurrentWorkspace() ws: string, @Param("key") key: string, @Body() dto: InstallSkillDto, @Req() req: Request & { user?: JwtPayload }) {
    return this.skills.install(ws, key, dto, req.user?.sub ?? null);
  }

  @Post(":key/update")
  update(@CurrentWorkspace() ws: string, @Param("key") key: string, @Body() dto: UpdateSkillDto) {
    return this.skills.update(ws, key, dto);
  }

  @Post(":key/retry")
  retry(@CurrentWorkspace() ws: string, @Param("key") key: string) {
    return this.skills.retry(ws, key);
  }

  @Patch(":key")
  patch(@CurrentWorkspace() ws: string, @Param("key") key: string, @Body() dto: PatchSkillDto) {
    return this.skills.patch(ws, key, dto);
  }

  @Delete(":key")
  uninstall(@CurrentWorkspace() ws: string, @Param("key") key: string) {
    return this.skills.uninstall(ws, key);
  }
}
