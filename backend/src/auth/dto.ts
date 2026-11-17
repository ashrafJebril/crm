import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { PASSWORD_MIN } from "../members/members-constants";

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

/** SP-26: POST /auth/password/forgot. */
export class ForgotPasswordDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsIn(["ar", "en"])
  lang?: "ar" | "en";
}

/** SP-26: POST /auth/password/reset. */
export class ResetPasswordDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;

  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(200)
  password!: string;
}

/** SP-26: POST /auth/2fa/enable. */
export class TwoFaEnableDto {
  @Matches(/^\d{6}$/)
  code!: string;
}

/** SP-26: POST /auth/2fa/verify: exactly one of `code` or `recoveryCode`
 *  (the service refuses both or neither). */
export class TwoFaVerifyDto {
  @IsString()
  @MaxLength(2048)
  challenge!: string;

  @IsOptional()
  @Matches(/^\d{6}$/)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  recoveryCode?: string;
}

/** SP-26: POST /auth/2fa/disable and POST /auth/2fa/recovery-codes: the
 *  password plus exactly one of a TOTP code or a recovery code. */
export class TwoFaDisableDto {
  @IsString()
  @MaxLength(200)
  password!: string;

  @IsOptional()
  @Matches(/^\d{6}$/)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  recoveryCode?: string;
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

export class KewySsoExchangeDto {
  /** The short-lived RS256 handoff token minted by the Kewy control panel. */
  @IsString()
  @IsNotEmpty()
  token!: string;
}

export class TiremallSsoExchangeDto {
  /** The short-lived HS256 handoff token minted by the Tiremall backend. */
  @IsString()
  @IsNotEmpty()
  token!: string;
}
