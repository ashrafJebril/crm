import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, ValidateNested } from "class-validator";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { LifecycleService } from "./lifecycle.service";

export class LifecycleRecipientDto {
  @IsIn(["customer", "assignee", "permitted", "members"]) kind!: "customer" | "assignee" | "permitted" | "members";
  @IsOptional() @IsArray() @IsString({ each: true }) userIds?: string[];
}

/** `PATCH /lifecycle/:key` (forbidNonWhitelisted through the global pipe). */
export class PatchLifecycleDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @ValidateNested() @Type(() => LifecycleRecipientDto) recipient?: LifecycleRecipientDto;
  @IsOptional() @IsInt() offsetMinutes?: number;
}

/**
 * SP-24 Automatic messages. Routes (permission-map.ts): GET `workflows.view`,
 * setup `workflows.create`, PATCH `workflows.update`, sync `templates.view`.
 * The sync route is declared before `:key` so it is never read as a key.
 */
@Controller("lifecycle")
export class LifecycleController {
  constructor(private readonly svc: LifecycleService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Post("sync")
  @HttpCode(200)
  sync(@CurrentWorkspace() workspaceId: string) {
    return this.svc.sync(workspaceId);
  }

  @Post(":key/setup")
  @HttpCode(200)
  setup(@CurrentWorkspace() workspaceId: string, @Param("key") key: string) {
    return this.svc.setup(workspaceId, key);
  }

  @Patch(":key")
  patch(@CurrentWorkspace() workspaceId: string, @Param("key") key: string, @Body() dto: PatchLifecycleDto) {
    return this.svc.patch(workspaceId, key, dto);
  }
}
