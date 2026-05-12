import { IsIn, IsOptional, IsString, MinLength } from "class-validator";

export const WORKSPACE_ROLES = ["owner", "admin", "agent", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export class CreateWorkspaceDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsString()
  @IsOptional()
  lang?: string;
}

export class UpdateWorkspaceDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsString()
  @IsOptional()
  lang?: string;

  @IsString()
  @IsOptional()
  plan?: string;
}

export class AddMemberDto {
  @IsString()
  @MinLength(1)
  userId!: string;

  @IsIn(WORKSPACE_ROLES as unknown as string[])
  role!: WorkspaceRole;
}

export class InviteByEmailDto {
  @IsString()
  @MinLength(3)
  email!: string;

  @IsIn(WORKSPACE_ROLES as unknown as string[])
  role!: WorkspaceRole;
}

export class UpdateMemberRoleDto {
  @IsIn(WORKSPACE_ROLES as unknown as string[])
  role!: WorkspaceRole;
}
