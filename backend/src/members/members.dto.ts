import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { PASSWORD_MIN } from "./members-constants";

export class CreateInvitationDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  roleId!: string;

  @IsOptional()
  @IsIn(["ar", "en"])
  lang?: "ar" | "en";
}

export class AcceptInvitationDto {
  /** 32 random bytes, base64url (43 chars). */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(200)
  password?: string;
}

/** POST /auth/invitations/accept (signed in): the emailed token. */
export class AcceptInvitationSignedInDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;
}

export class RemoveMemberDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  handoverTo?: string;
}

export class HandoverDto {
  @IsString()
  @MinLength(1)
  handoverTo!: string;
}
