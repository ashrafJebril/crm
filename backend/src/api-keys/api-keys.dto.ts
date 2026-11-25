import { IsObject, IsOptional, IsString, MaxLength } from "class-validator";

/** POST /api-keys. Scopes and expiry are validated by the service (so the
 *  error keys are the SP-27 ones). */
export class CreateApiKeyDto {
  @IsString()
  @MaxLength(60)
  name!: string;

  @IsObject()
  scopes!: Record<string, string[]>;

  @IsOptional()
  @IsString()
  expiresAt?: string;
}
