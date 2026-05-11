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
