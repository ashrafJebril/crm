import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from "class-validator";

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  color?: string;

  // Workspace name to create for this new user (they become owner).
  // Falls back to "{name}'s workspace" if omitted.
  @IsOptional()
  @IsString()
  workspaceName?: string;
}

export class SwitchWorkspaceDto {
  @IsString()
  @MinLength(1)
  workspaceId!: string;
}

export class UpdateProfileDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  color?: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(6)
  currentPassword!: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;
}

/**
 * Body for POST /auth/sso/exchange. `token` is an hjz-v2 access token signed
 * with hjz's JWT_ACCESS_SECRET. `email`/`name` are optional profile hints the
 * hjz web shell forwards so the mirrored tkana user has a friendly identity;
 * absent, tkana synthesizes a namespaced placeholder keyed off the hjz user id.
 */
export class SsoExchangeDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;
}
