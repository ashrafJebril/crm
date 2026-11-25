import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export const CONVERSATION_VISIBILITIES = ["all", "assigned"] as const;

export class CreateRoleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  nameAr!: string;

  /** { [resource]: Action[] } - validated against the catalog in the service. */
  @IsObject()
  permissions!: Record<string, unknown>;

  @IsOptional()
  @IsIn(CONVERSATION_VISIBILITIES as unknown as string[])
  conversationVisibility?: "all" | "assigned";
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  nameAr?: string;

  @IsOptional()
  @IsObject()
  permissions?: Record<string, unknown>;

  @IsOptional()
  @IsIn(CONVERSATION_VISIBILITIES as unknown as string[])
  conversationVisibility?: "all" | "assigned";
}
