import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MinLength } from "class-validator";

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

/** Provision a brand-new client in one shot: workspace + owner user + password.
 *  Lets a super-admin hand pre-built credentials to a customer instead of
 *  asking them to sign up first. */
export class ProvisionClientDto {
  @IsString()
  @MinLength(2)
  workspaceName!: string;

  @IsEmail()
  ownerEmail!: string;

  @IsString()
  @MinLength(2)
  ownerName!: string;

  @IsString()
  @MinLength(6)
  ownerPassword!: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  lang?: string;
}
