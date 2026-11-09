import { Transform } from "class-transformer";
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from "class-validator";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export const SHORTCUT_RE = /^[a-z0-9_-]{1,32}$/;

export class CreateSavedReplyDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(80) title!: string;
  @IsString() @IsNotEmpty() @MaxLength(4000) body!: string;
  @IsOptional() @IsString() @MaxLength(4000) bodyAr?: string;
  @IsString() @Matches(SHORTCUT_RE) shortcut!: string;
}

export class UpdateSavedReplyDto {
  @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(80) title?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(4000) body?: string;
  @IsOptional() @IsString() @MaxLength(4000) bodyAr?: string;
  @IsOptional() @IsString() @Matches(SHORTCUT_RE) shortcut?: string;
}
