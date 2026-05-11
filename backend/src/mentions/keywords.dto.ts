import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from "class-validator";

export const KEYWORD_KINDS = ["brand", "hashtag", "handle", "competitor"] as const;
export type KeywordKind = (typeof KEYWORD_KINDS)[number];

export class CreateKeywordDto {
  @IsString()
  @MinLength(1)
  value!: string;

  @IsIn(KEYWORD_KINDS as unknown as string[])
  kind!: KeywordKind;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsString()
  @IsOptional()
  notes?: string;
}

export class UpdateKeywordDto {
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsString()
  @IsOptional()
  notes?: string;
}
