import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from "class-validator";

const PLAN_VALUES = ["free", "starter", "growth", "pro"] as const;

export class UpdateWorkspaceAdminDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsString()
  @IsOptional()
  lang?: string;

  // Super-admins CAN change plan (regular owners cannot).
  @IsIn(PLAN_VALUES as unknown as string[])
  @IsOptional()
  plan?: (typeof PLAN_VALUES)[number];
}

export class SuspendWorkspaceDto {
  @IsBoolean()
  suspended!: boolean;
}

export class ImpersonateDto {
  @IsString()
  @MinLength(1)
  workspaceId!: string;
}
