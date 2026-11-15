import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength, ValidateIf } from "class-validator";
import { MEDIA_DETAIL_LIMITS } from "./media-details";

// No body DTO for upload — multipart is parsed by Multer.

/**
 * SP-17 `PATCH /media/:id`. Every field is optional; an empty body is 400
 * media.no_changes (service). `null` or `""` clears a text field. The global
 * pipe (whitelist + forbidNonWhitelisted) refuses unknown fields.
 */
export class UpdateMediaDto {
  @IsOptional()
  @IsString()
  @MaxLength(MEDIA_DETAIL_LIMITS.title)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(MEDIA_DETAIL_LIMITS.alt)
  alt?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MEDIA_DETAIL_LIMITS.tags)
  @IsString({ each: true })
  @MaxLength(MEDIA_DETAIL_LIMITS.tag, { each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(MEDIA_DETAIL_LIMITS.useWhen)
  useWhen?: string | null;

  // null is not a value here: only true or false.
  @ValidateIf((_, v) => v !== undefined)
  @IsBoolean()
  approvedForAgent?: boolean;
}
